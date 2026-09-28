import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseCli, type CliOptions } from "../src/cli/args.ts";
import { dispatchKind } from "../src/cli/main.ts";
import type { LoadedConfig } from "../src/config/load.ts";
import type { Answer, DecisionEngine, EvaluateRequest, Question } from "../src/engine/types.ts";
import type { HealthFunction } from "../src/fallow/health.ts";
import { reviewAdapter } from "../src/kinds/review.ts";
import { checkWith } from "../src/pipeline/check.ts";
import { closeWith } from "../src/pipeline/close.ts";
import { judgeWith } from "../src/pipeline/judge.ts";
import { scanWith } from "../src/pipeline/scan.ts";
import { globMatcher } from "../src/review/glob.ts";
import { buildReviewPacket } from "../src/review/packet.ts";
import { decideReview } from "../src/review/policy.ts";
import { rulesFor, whereOptions } from "../src/review/questions.ts";
import { identify, runReviewScan, selectUnits, type ReviewUnit } from "../src/review/units.ts";
import { openStore, type Store } from "../src/state/store.ts";
import { ok } from "../src/util/result.ts";
import { makeLoaded, makeProject } from "./helpers.ts";

const repo = fileURLToPath(new URL("../", import.meta.url));
const FALLOW = path.join(repo, "node_modules/.bin/fallow");

/** One function above the default complexity thresholds of Fallow health. */
const HOT_SOURCE = [
  "export const classify = (value: number, flag: boolean, mode: string): string => {",
  ...Array.from(
    { length: 24 },
    (_, index) => `  if (value === ${index} && (flag || mode === "m${index}")) return "v${index}";`,
  ),
  '  return "other";',
  "};",
  "",
].join("\n");

const CALC_SOURCE = [
  'import { readFileSync } from "node:fs";',
  "",
  "// Adds two numbers.",
  "export const add = (a: number, b: number): number => {",
  "  const twice = (x: number): number => x * 2;",
  "  return twice(a) / 2 + b;",
  "};",
  "",
  "export const read = (file: string): string => readFileSync(file, 'utf8');",
  "",
].join("\n");

const PROJECT = {
  "package.json": JSON.stringify({ name: "review-fixture", type: "module" }),
  "src/hot.ts": HOT_SOURCE,
  "src/calc.ts": CALC_SOURCE,
};

const reviewLoaded = async (review: Record<string, unknown> = {}): Promise<LoadedConfig> => {
  const root = await makeProject(PROJECT);
  return makeLoaded(root, { fallow: { binary: FALLOW }, review });
};

const reviewStore = (loaded: LoadedConfig): Store => openStore(loaded.dataDir, "review");

const fn = (overrides: Partial<HealthFunction>): HealthFunction => ({
  path: "src/a.ts",
  name: "f",
  line: 1,
  col: 1,
  cyclomatic: 1,
  cognitive: 0,
  line_count: 3,
  severity: "moderate",
  ...overrides,
});

type EngineProbabilities = { bug: number; rules?: number; claims?: number };

const answer = (id: string, question: Question, p: EngineProbabilities): Answer => {
  if (question.type === "noul") {
    const probability =
      id === "has_bug"
        ? p.bug
        : id === "does_what_it_claims"
          ? (p.claims ?? 0.9)
          : (p.rules ?? 0.1);
    return { type: "noul", probability };
  }
  if (question.type === "choice") {
    const choice = Object.keys(question.criteria)[0] ?? "none";
    return { type: "choice", choice, probabilities: { [choice]: 1 }, confidence: 1 };
  }
  return { type: "score", score: 2, probabilities: [0, 0.1, 0.8, 0.1], confidence: 0.8 };
};

/** Answers every question it gets; records the requests. `sequence` varies P(bug) per call. */
const reviewEngine = (
  sequence: readonly EngineProbabilities[],
): DecisionEngine & { requests: EvaluateRequest[] } => {
  const engine = {
    id: "review-stub",
    requests: [] as EvaluateRequest[],
    evaluate: (request: EvaluateRequest) => {
      const p = sequence[Math.min(engine.requests.length, sequence.length - 1)] ?? { bug: 0.1 };
      engine.requests.push(request);
      const answers = Object.fromEntries(
        Object.entries(request.questions).map(([id, question]) => [id, answer(id, question, p)]),
      );
      return Promise.resolve(
        ok({ model: "review-stub-1", answers, inputTokens: 500, latencyMs: 1 }),
      );
    },
  };
  return engine;
};

const optionsFor = (argv: string[]): CliOptions => {
  const parsed = parseCli(argv);
  if (!parsed.ok || parsed.data.kind !== "command") throw new Error("Invalid test arguments");
  return parsed.data.options;
};

const scanned = async (loaded: LoadedConfig, paths: string[] = ["src"]): Promise<Store> => {
  const store = reviewStore(loaded);
  const result = await scanWith(reviewAdapter, loaded, store, { paths });
  if (!result.ok) throw new Error(result.error.message);
  return store;
};

const units = async (store: Store): Promise<ReviewUnit[]> =>
  (JSON.parse(await readFile(store.candidatesPath, "utf8")) as { units: ReviewUnit[] }).units;

describe("review unit selection", () => {
  it("puts hotspots first, folds nested functions into the outer one and merges reasons", () => {
    const selected = selectUnits(
      [
        fn({
          path: "src/hot.ts",
          name: "hot",
          line: 10,
          line_count: 30,
          severity: "high",
          cognitive: 40,
        }),
      ],
      [
        {
          reason: "changed",
          functions: [
            fn({ path: "src/a.ts", name: "outer", line: 1, line_count: 10, cognitive: 2 }),
            fn({ path: "src/a.ts", name: "inner", line: 3, line_count: 2, cognitive: 9 }),
            fn({ path: "src/a.ts", name: "big", line: 20, line_count: 5, cognitive: 5 }),
            fn({ path: "src/hot.ts", name: "hot", line: 10, line_count: 30, cognitive: 40 }),
          ],
        },
      ],
    );
    expect(selected.map((unit) => unit.name)).toEqual(["hot", "outer", "big"]);
    expect(selected[0]).toMatchObject({ hotspot: "high", selected: ["hotspot", "changed"] });
    // The nested function adds its complexity to the outer function, not a unit of its own.
    expect(selected[1]).toMatchObject({ cognitive: 9, end_line: 10 });
  });

  it("scans every function in scope with Fallow and caps the units, highest risk first", async () => {
    const loaded = await reviewLoaded({ maxUnits: 2 });
    const scan = await runReviewScan(loaded, { paths: ["src"] });
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    expect(scan.data.in_scope).toBe(3);
    expect(scan.data.units).toHaveLength(2);
    expect(scan.data.units[0]).toMatchObject({
      path: "src/hot.ts",
      name: "classify",
      selected: ["hotspot", "path"],
    });
    expect(scan.data.units.every((unit) => unit.finding_id.startsWith("review:src/"))).toBe(true);
  });

  it("selects only hotspots without a scope", async () => {
    const loaded = await reviewLoaded();
    const scan = await runReviewScan(loaded, {});
    expect(scan.ok && scan.data.units.map((unit) => unit.name)).toEqual(["classify"]);
  });

  it("selects the functions of files changed since a Git ref", async () => {
    const loaded = await reviewLoaded();
    const git = (...args: string[]): void => {
      execFileSync("git", args, { cwd: loaded.root, stdio: "ignore" });
    };
    git("init", "-q");
    git("-c", "user.email=t@example.com", "-c", "user.name=t", "add", ".");
    git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "base");
    await writeFile(path.join(loaded.root, "src/calc.ts"), `${CALC_SOURCE}// Changed.\n`);
    const scan = await runReviewScan(loaded, { changedSince: "HEAD" });
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    expect(scan.data.units.map((unit) => [unit.name, unit.selected])).toEqual([
      ["add", ["changed"]],
      ["read", ["changed"]],
    ]);
  });
});

describe("review unit identity", () => {
  it("gives an edited function a new id and keeps the id when only the lines move", async () => {
    const root = await makeProject(PROJECT);
    const selection = selectUnits(
      [],
      [
        {
          reason: "path",
          functions: [fn({ path: "src/calc.ts", name: "add", line: 4, line_count: 4 })],
        },
      ],
    );
    const [before] = await identify(root, selection);
    await writeFile(path.join(root, "src/calc.ts"), CALC_SOURCE.replace("+ b", "- b"));
    const [edited] = await identify(root, selection);
    await writeFile(path.join(root, "src/calc.ts"), `// Moved.\n${CALC_SOURCE}`);
    const moved = selectUnits(
      [],
      [
        {
          reason: "path",
          functions: [fn({ path: "src/calc.ts", name: "add", line: 5, line_count: 4 })],
        },
      ],
    );
    const [shifted] = await identify(root, moved);
    expect(before?.finding_id).toMatch(/^review:src\/calc\.ts:add:[0-9a-f]{12}$/);
    expect(edited?.finding_id).not.toBe(before?.finding_id);
    expect(shifted?.finding_id).toBe(before?.finding_id);
  });
});

describe("review questions", () => {
  it("scopes project rules by `where` and `except`", () => {
    const config = makeLoaded("/", {
      review: {
        rules: [
          {
            name: "env-read-once",
            where: "src/**/*.ts",
            except: "src/config/**",
            ensure: "No env.",
          },
          { name: "tests-only", where: ["test/**", "**/*.test.ts"], ensure: "Uses vitest." },
        ],
      },
    }).config.review;
    const names = (file: string): string[] => rulesFor(config, file).map((rule) => rule.name);
    expect(names("src/app/main.ts")).toEqual(["env-read-once"]);
    expect(names("src/config/load.ts")).toEqual([]);
    expect(names("src/app/main.test.ts")).toEqual(["env-read-once", "tests-only"]);
    expect(names("lib/main.ts")).toEqual([]);
    expect(globMatcher("src/*.{ts,tsx}")("src/a.tsx")).toBe(true);
    expect(globMatcher("src/*.ts")("src/a/b.ts")).toBe(false);
  });

  it("offers line ranges for a long function and always a `none` option", () => {
    expect(Object.keys(whereOptions({ start: 5, end: 7 }))).toEqual(["L5", "L6", "L7", "none"]);
    const long = Object.keys(whereOptions({ start: 1, end: 100 }));
    expect(long).toHaveLength(35);
    expect(long[0]).toBe("L1-L3");
    expect(long.at(-2)).toBe("L100");
  });

  it("sends the built-in questions and every rule in scope in one request per unit", async () => {
    const loaded = await reviewLoaded({
      rules: [{ name: "no-fs", where: "src/calc.ts", ensure: "The function does not read files." }],
    });
    const store = await scanned(loaded);
    const engine = reviewEngine([{ bug: 0.1 }]);
    const judged = await judgeWith(reviewAdapter, loaded, store, engine, {
      rejudge: false,
      dryRun: false,
    });
    expect(judged).toMatchObject({ ok: true, data: { judged: 3, errors: 0 } });
    // Dismissals are single calls by default for review mode: one request per unit.
    expect(engine.requests).toHaveLength(3);
    const questionSets = engine.requests.map((request) =>
      Object.keys(request.questions).toSorted(),
    );
    expect(questionSets).toContainEqual([
      "does_what_it_claims",
      "has_bug",
      "rule_no_fs",
      "severity",
      "where",
    ]);
    expect(questionSets).toContainEqual(["does_what_it_claims", "has_bug", "severity", "where"]);
  });
});

const policyAnswers = (bug: number, rule: number): Record<string, Answer> => ({
  has_bug: { type: "noul", probability: bug },
  does_what_it_claims: { type: "noul", probability: 0.9 },
  rule_no_fs: { type: "noul", probability: rule },
  where: { type: "choice", choice: "L6", probabilities: { L6: 0.9 }, confidence: 0.9 },
  severity: { type: "score", score: 2, probabilities: [0, 0, 1, 0], confidence: 1 },
});

describe("review policy", () => {
  const built = async (): Promise<Awaited<ReturnType<typeof buildReviewPacket>>> => {
    const root = await makeProject(PROJECT);
    const [unit] = await identify(
      root,
      selectUnits(
        [],
        [
          {
            reason: "path",
            functions: [fn({ path: "src/calc.ts", name: "add", line: 4, line_count: 4 })],
          },
        ],
      ),
    );
    if (unit === undefined) throw new Error("Missing unit");
    return buildReviewPacket(unit, root, 28_000);
  };
  const config = makeLoaded("/", {
    review: { rules: [{ name: "no-fs", where: "src/**", ensure: "No file reads.", floor: 0.8 }] },
  }).config.review;

  it("maps answers to survivor, dismissed or a review by a person", async () => {
    const evidence = await built();
    expect(evidence.packet.leading_comment).toContain("Adds two numbers.");
    expect(evidence.packet.imports).toContain('import { readFileSync } from "node:fs";');
    expect(decideReview(policyAnswers(0.7, 0.1), evidence, config)).toMatchObject({
      verdict: "survivor",
      rule: "has-bug",
      confidence: 0.7,
      probabilities: { has_bug: 0.7, "rule:no-fs": 0.1 },
      impact: { label: "major" },
      kindData: { name: "add", where: "L6", breaches: [] },
    });
    expect(decideReview(policyAnswers(0.2, 0.85), evidence, config)).toMatchObject({
      verdict: "survivor",
      rule: "rule-breach",
      kindData: { breaches: ["no-fs"] },
    });
    // The rule has its own floor of 0.8.
    expect(decideReview(policyAnswers(0.2, 0.7), evidence, config)).toMatchObject({
      verdict: "dismissed",
      rule: "no-likely-problem",
      confidence: expect.closeTo(0.3) as unknown as number,
      kindData: { where: null },
    });
    const { rule_no_fs: _missing, ...partial } = policyAnswers(0.9, 0.1);
    expect(decideReview(partial, evidence, config)).toMatchObject({
      verdict: "needs-human-review",
      rule: "answers-missing",
    });
    expect(
      decideReview(policyAnswers(0.9, 0.1), { ...evidence, truncated: true }, config),
    ).toMatchObject({ verdict: "needs-human-review", rule: "truncated-evidence" });
    expect(
      decideReview(policyAnswers(0.1, 0.1), { ...evidence, sourceChanged: true }, config),
    ).toMatchObject({ verdict: "needs-human-review", rule: "source-changed" });
  });

  it("cuts a large function to the token budget and marks the evidence truncated", async () => {
    const root = await makeProject(PROJECT);
    const [unit] = await identify(
      root,
      selectUnits(
        [],
        [
          {
            reason: "path",
            functions: [fn({ path: "src/hot.ts", name: "classify", line: 1, line_count: 27 })],
          },
        ],
      ),
    );
    if (unit === undefined) throw new Error("Missing unit");
    const small = await buildReviewPacket(unit, root, 700);
    expect(small.truncated).toBe(true);
    expect(small.stateTokens).toBeLessThanOrEqual(700);
    expect(small.packet.omitted.at(-1)).toMatch(/^source after line \d+$/);
    expect(small.lines?.end).toBeLessThan(27);
  });
});

describe("review mode in the pipeline", () => {
  it("is advisory: survivors do not fail the report unless failOn is set for review", async () => {
    const loaded = await reviewLoaded();
    const store = await scanned(loaded);
    await judgeWith(reviewAdapter, loaded, store, reviewEngine([{ bug: 0.9 }]), {
      rejudge: false,
      dryRun: false,
    });
    const report = (argv: string[], config: LoadedConfig = loaded) =>
      dispatchKind(reviewAdapter, {
        options: optionsFor(["report", "--quiet", "--kind", "review", ...argv]),
        loaded: config,
        store,
        signal: new AbortController().signal,
      });
    const advisory = await report([]);
    expect(advisory).toMatchObject({ ok: true, data: { exitCode: 0 } });
    if (!advisory.ok) return;
    expect(advisory.data.human).toContain("Code review");
    expect(advisory.data.human).toContain("Likely problems (3)");
    expect(advisory.data.human).toContain("Model estimate of a bug: 90%");
    expect(await report(["--fail-on", "survivor"])).toMatchObject({ data: { exitCode: 1 } });
    const failing = {
      ...loaded,
      config: {
        ...loaded.config,
        review: { ...loaded.config.review, failOn: "survivor" as const },
      },
    };
    expect(await report([], failing)).toMatchObject({ data: { exitCode: 1 } });
    // The top-level failOn is the security gate; it does not make review mode fail.
    expect(loaded.config.failOn).toBe("survivor");

    const verdicts = await store.readJson(store.verdictsPath);
    expect(verdicts).toMatchObject({
      ok: true,
      data: { schema_version: "fallow-verdict-review-verdicts/v1", advisory: true },
    });
    const markdown = await readFile(store.reportPath, "utf8");
    expect(markdown).toContain("# Code review");
  });

  it("applies the two-call rule to review dismissals only when review.confirmDismissals is set", async () => {
    const base = await reviewLoaded({ confirmDismissals: true });
    // One worker, so the answer sequence maps to the calls in order.
    const loaded = {
      ...base,
      config: { ...base.config, engine: { ...base.config.engine, concurrency: 1 } },
    };
    const store = await scanned(loaded, ["src/calc.ts"]);
    // First call dismisses, the second call disagrees.
    const engine = reviewEngine([{ bug: 0.1 }, { bug: 0.8 }, { bug: 0.1 }, { bug: 0.1 }]);
    const plan = await judgeWith(reviewAdapter, loaded, store, engine, {
      rejudge: false,
      dryRun: true,
    });
    expect(plan.ok && plan.data.maxConfirmationUsd).toBeGreaterThan(0);
    await judgeWith(reviewAdapter, loaded, store, engine, { rejudge: false, dryRun: false });
    expect(engine.requests).toHaveLength(4);
    const verdicts = (await store.readRecords()).records.map((record) => [
      record.decision?.verdict,
      record.decision?.rule,
    ]);
    expect(verdicts).toContainEqual(["needs-human-review", "dismissal-unconfirmed"]);
    expect(verdicts).toContainEqual(["dismissed", "no-likely-problem"]);

    const single = await reviewLoaded();
    const singleStore = await scanned(single, ["src/calc.ts"]);
    const dry = await judgeWith(reviewAdapter, single, singleStore, reviewEngine([{ bug: 0.1 }]), {
      rejudge: false,
      dryRun: true,
    });
    expect(dry).toMatchObject({ ok: true, data: { maxConfirmationUsd: 0, pending: 2 } });
  });

  it("shows the unit count and the cost of a dry run without a call", async () => {
    const loaded = await reviewLoaded();
    const outcome = await dispatchKind(reviewAdapter, {
      options: optionsFor(["run", "--quiet", "--kind", "review", "--dry-run", "src"]),
      loaded,
      store: reviewStore(loaded),
      signal: new AbortController().signal,
    });
    expect(outcome).toMatchObject({
      ok: true,
      data: { exitCode: 0, json: { pending: 3, judged: 0 } },
    });
    expect(
      outcome.ok && (outcome.data.json as { estimatedUsd: number }).estimatedUsd,
    ).toBeGreaterThan(0);
  });

  it("checks an edited function again instead of reporting it resolved", async () => {
    const loaded = await reviewLoaded();
    const store = await scanned(loaded);
    const add = (await units(store)).find((unit) => unit.name === "add");
    if (add === undefined) throw new Error("Missing unit");
    await writeFile(path.join(loaded.root, "src/calc.ts"), CALC_SOURCE.replace("+ b", "- b"));
    const engine = reviewEngine([{ bug: 0.1 }]);
    const check = (target: string) =>
      checkWith(reviewAdapter, loaded, store, {
        target,
        cwd: loaded.root,
        dryRun: false,
        engine: () => ok(engine),
      });
    const edited = await check(add.finding_id);
    expect(edited).toMatchObject({
      ok: true,
      data: {
        report: {
          kind: "review",
          outcome: "cleared",
          results: [{ status: "judged", verdict: "dismissed", stored_id: add.finding_id }],
        },
      },
    });
    expect(edited.ok && edited.data.report.results[0]?.finding_id).not.toBe(add.finding_id);

    // The function is gone, but other functions remain in the file: a person decides.
    await writeFile(
      path.join(loaded.root, "src/calc.ts"),
      "export const read = (file: string): string => file;\n",
    );
    expect(await check(add.finding_id)).toMatchObject({
      ok: true,
      data: { report: { outcome: "needs-person", results: [{ status: "ambiguous" }] } },
    });
  });

  it("keeps a closed unit out of the next assessment while its source is the same", async () => {
    const loaded = await reviewLoaded();
    const store = await scanned(loaded, ["src/calc.ts"]);
    const [unit] = await units(store);
    if (unit === undefined) throw new Error("Missing unit");
    await judgeWith(reviewAdapter, loaded, store, reviewEngine([{ bug: 0.9 }]), {
      rejudge: false,
      dryRun: false,
    });
    expect(
      await closeWith(reviewAdapter, loaded, store, unit.finding_id, "Intended."),
    ).toMatchObject({ ok: true });
    const engine = reviewEngine([{ bug: 0.9 }]);
    await judgeWith(reviewAdapter, loaded, store, engine, { rejudge: true, dryRun: false });
    expect(engine.requests).toHaveLength(1);
  });
});
