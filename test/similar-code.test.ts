import { cp, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseCli, type CliOptions } from "../src/cli/args.ts";
import { dispatchKind } from "../src/cli/main.ts";
import { configSchema } from "../src/config/schema.ts";
import type { LoadedConfig } from "../src/config/load.ts";
import type { Answer, DecisionEngine } from "../src/engine/types.ts";
import { bindPairLabels, evaluatePairs, pairLabelsSchema } from "../src/eval/similar-code.ts";
import {
  parseSimilarCodeOutput,
  runSimilarCodeScan,
  type SimilarCodeInspectOutput,
  type SimilarCodeOutput,
} from "../src/fallow/similar-code.ts";
import { similarCodeAdapter } from "../src/kinds/similar-code.ts";
import { kindFor } from "../src/kinds/registry.ts";
import { pairFromInspect, type PairPacket } from "../src/packet/similar-code.ts";
import { checkWith, type CheckOptions } from "../src/pipeline/check.ts";
import { closeWith } from "../src/pipeline/close.ts";
import { confirmedVerdicts, judgeWith } from "../src/pipeline/judge.ts";
import { scanWith } from "../src/pipeline/scan.ts";
import { decideSimilarCode, orderAxes } from "../src/policy/similar-code.ts";
import type { StoredDecision } from "../src/state/schema.ts";
import { openStore, type Store } from "../src/state/store.ts";
import { verdictError } from "../src/util/errors.ts";
import { err, ok } from "../src/util/result.ts";
import { renderCheckHuman } from "../src/report/check.ts";
import { confirmationBoundLine } from "../src/report/render.ts";
import { toSimilarCodeVerdicts } from "../src/verdicts/similar-code.ts";

/** Tests that run the real `fallow similar-code inspect` once for each pair. */
const INSPECT_TIMEOUT = { timeout: 60_000 };

const repo = fileURLToPath(new URL("../", import.meta.url));
const evalDir = path.join(repo, "eval/similar-code");
const realFallow = path.join(repo, "node_modules/.bin/fallow");
const KIND = "similar-code";
const POLICY = configSchema.parse({}).similarCode.policy;

const readJson = async (file: string): Promise<unknown> =>
  JSON.parse(await readFile(file, "utf8")) as unknown;

const recorded = async (): Promise<SimilarCodeOutput> => {
  const parsed = parseSimilarCodeOutput(await readJson(path.join(evalDir, "discovery.json")));
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.data;
};

type StubAnswers = { answers: Record<string, Record<string, Answer>> };

const stubAnswers = async (): Promise<StubAnswers> =>
  (await readJson(path.join(evalDir, "stub-answers.json"))) as StubAnswers;

const labels = async (): Promise<ReturnType<typeof pairLabelsSchema.parse>> =>
  pairLabelsSchema.parse(await readJson(path.join(evalDir, "labels.json")));

/**
 * A copy of the corpus and a stub `fallow`: discovery prints the given document, because the
 * model download needs a human decision. `inspect` and `review` run the real Fallow binary.
 */
const corpus = async (
  discovery: SimilarCodeOutput,
  config: Record<string, unknown> = {},
): Promise<{
  root: string;
  loaded: LoadedConfig;
  store: Store;
  argsLog: string;
  inspectLog: string;
}> => {
  const root = await mkdtemp(path.join(tmpdir(), "verdict-similar-code-"));
  await cp(path.join(evalDir, "corpus"), root, { recursive: true });
  const discoveryFile = path.join(root, ".discovery.json");
  const argsLog = path.join(root, ".args.log");
  const inspectLog = path.join(root, ".inspect.log");
  await writeFile(discoveryFile, JSON.stringify(discovery));
  const binary = path.join(root, ".fallow-stub.mjs");
  await writeFile(
    binary,
    [
      "#!/usr/bin/env node",
      'import { appendFileSync, readFileSync } from "node:fs";',
      'import { spawnSync } from "node:child_process";',
      "const args = process.argv.slice(2);",
      'if (args[0] === "similar-code" && args[1] !== "inspect" && args[1] !== "review") {',
      `  appendFileSync(${JSON.stringify(argsLog)}, JSON.stringify(args) + "\\n");`,
      `  process.stdout.write(readFileSync(${JSON.stringify(discoveryFile)}, "utf8"));`,
      "  process.exit(0);",
      "}",
      `if (args[1] === "inspect") appendFileSync(${JSON.stringify(inspectLog)}, args[2] + "\\n");`,
      `const child = spawnSync(${JSON.stringify(realFallow)}, args, { encoding: "utf8" });`,
      "process.stdout.write(child.stdout ?? '');",
      "process.stderr.write(child.stderr ?? '');",
      "process.exit(child.status ?? 2);",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const loaded: LoadedConfig = {
    config: configSchema.parse({ ...config, fallow: { binary } }),
    root,
    dataDir: path.join(root, ".fallow-verdict"),
    configPath: null,
  };
  return { root, loaded, store: openStore(loaded.dataDir, KIND), argsLog, inspectLog };
};

const pairName = (state: unknown): string => {
  const { left, right } = (state as PairPacket).candidate;
  return [left.name, right.name].toSorted().join("~");
};

const UNCERTAIN: Record<string, Answer> = {
  candidate_worthy: { type: "noul", probability: 0.6 },
  behaviorally_equivalent: { type: "noul", probability: 0.5 },
  refactor_safe: { type: "noul", probability: 0.4 },
  outcome: {
    type: "choice",
    choice: "related-but-distinct",
    probabilities: { "related-but-distinct": 0.5 },
    confidence: 0.5,
  },
};

/** Answers from the stub answer file for labeled pairs, and uncertain answers for the others. */
const corpusEngine = async (): Promise<DecisionEngine & { calls: string[] }> => {
  const { answers } = await stubAnswers();
  const byPair = new Map(
    Object.entries(answers).map(([id, set]) => [id.split("~").toSorted().join("~"), set]),
  );
  const engine = {
    id: "stub",
    calls: [] as string[],
    evaluate: (request: { state: unknown }) => {
      const pair = pairName(request.state);
      engine.calls.push(pair);
      return Promise.resolve(
        ok({
          model: "stub-1",
          answers: byPair.get(pair) ?? UNCERTAIN,
          inputTokens: 900,
          latencyMs: 1,
        }),
      );
    },
  };
  return engine;
};

const noul = (probability: number): Answer => ({ type: "noul", probability });
const choice = (value: string, confidence: number): Answer => ({
  type: "choice",
  choice: value,
  probabilities: { [value]: confidence },
  confidence,
});
const answers = (cw: number, be: number, rs: number, outcome: string, conf = 0.9) => ({
  candidate_worthy: noul(cw),
  behaviorally_equivalent: noul(be),
  refactor_safe: noul(rs),
  outcome: choice(outcome, conf),
});

const optionsFor = (argv: string[]): CliOptions => {
  const parsed = parseCli(argv);
  if (!parsed.ok || parsed.data.kind !== "command") throw new Error("Invalid test arguments");
  return parsed.data.options;
};

const idOf = (output: SimilarCodeOutput, left: string, right: string): string => {
  const found = output.candidates.find(
    (candidate) =>
      [candidate.left.name, candidate.right.name].toSorted().join("~") ===
      [left, right].toSorted().join("~"),
  );
  if (found === undefined) throw new Error(`No pair ${left}~${right}`);
  return found.candidate_id;
};

describe("similar-code discovery", () => {
  it("is registered as a kind", () => {
    expect(kindFor(KIND).kind).toBe(KIND);
  });

  it("rejects an unknown schema version, a missing review key and duplicate ids", async () => {
    const output = await recorded();
    expect(parseSimilarCodeOutput({ ...output, schema_version: "2" })).toMatchObject({
      ok: false,
      error: { code: "fallow_schema_unsupported" },
    });
    const [first] = output.candidates;
    if (first === undefined) throw new Error("Empty corpus");
    const { review_key: _key, ...withoutKey } = first;
    expect(parseSimilarCodeOutput({ ...output, candidates: [withoutKey] })).toMatchObject({
      ok: false,
      error: { code: "fallow_output_invalid" },
    });
    expect(parseSimilarCodeOutput({ ...output, candidates: [first, first] })).toMatchObject({
      ok: false,
      error: { code: "fallow_output_invalid" },
    });
  });

  it("stores the discovery unchanged and records both functions of each pair", async () => {
    const output = await recorded();
    const { loaded, store } = await corpus(output);
    const scanned = await scanWith(similarCodeAdapter, loaded, store, {});
    expect(scanned).toMatchObject({
      ok: true,
      data: { candidates: output.candidates.length, added: output.candidates.length },
    });
    expect(await readJson(store.candidatesPath)).toEqual(output);
    const { records } = await store.readRecords();
    const id = idOf(output, "sumPrices", "totalCost");
    const pair = output.candidates.find((candidate) => candidate.candidate_id === id);
    expect(records.find((record) => record.finding_id === id)).toMatchObject({
      kind: KIND,
      severity: null,
      category: pair?.similarity_band,
      locations: [
        {
          path: pair?.left.path,
          line: pair?.left.start_line,
          col: (pair?.left.start_column ?? 1) - 1,
        },
        {
          path: pair?.right.path,
          line: pair?.right.start_line,
          col: (pair?.right.start_column ?? 1) - 1,
        },
      ],
    });
  });

  it("never resolves a stored pair after an incomplete discovery", async () => {
    const output = await recorded();
    const { loaded, store, root } = await corpus(output);
    await scanWith(similarCodeAdapter, loaded, store, {});
    const [kept, ...gone] = output.candidates;
    if (kept === undefined) throw new Error("Empty corpus");
    const partial: SimilarCodeOutput = { ...output, candidates: [kept] };
    expect(partial.completion.status).toBe("partial");
    await writeFile(path.join(root, ".discovery.json"), JSON.stringify(partial));
    expect(await scanWith(similarCodeAdapter, loaded, store, {})).toMatchObject({
      ok: true,
      data: { resolved: 0 },
    });

    const complete: SimilarCodeOutput = {
      ...partial,
      completion: { ...partial.completion, status: "complete" },
    };
    await writeFile(path.join(root, ".discovery.json"), JSON.stringify(complete));
    expect(await scanWith(similarCodeAdapter, loaded, store, {})).toMatchObject({
      ok: true,
      data: { resolved: gone.length },
    });
  });

  it("passes a file scope to Fallow and filters a directory scope locally", async () => {
    const output = await recorded();
    const { root, argsLog } = await corpus(output);
    const binary = path.join(root, ".fallow-stub.mjs");
    const byFile = await runSimilarCodeScan({ root, binary, paths: ["src/index.ts"] });
    const byDirectory = await runSimilarCodeScan({ root, binary, paths: ["src"] });
    const calls = (await readFile(argsLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(calls[0]).toEqual(expect.arrayContaining(["--file", "src/index.ts"]));
    expect(calls[1]).not.toContain("--file");
    expect(byFile.ok && byDirectory.ok).toBe(true);
    if (!byDirectory.ok) return;
    expect(byDirectory.data.candidates).toHaveLength(output.candidates.length);
  });

  it("surfaces a Fallow failure with the setup hint and never runs setup", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "verdict-similar-code-"));
    const binary = path.join(root, "fallow-missing-model.mjs");
    await writeFile(
      binary,
      `#!/usr/bin/env node\nif (process.argv.includes("setup")) process.exit(99);\nprocess.stdout.write(JSON.stringify({ error: true, message: "similar-code local model is not ready; run setup", exit_code: 2 }));\nprocess.exit(2);\n`,
      { mode: 0o755 },
    );
    const result = await runSimilarCodeScan({ root, binary });
    expect(result).toMatchObject({ ok: false, error: { code: "fallow_failed" } });
    if (result.ok) return;
    expect(result.error.message).toContain("not ready");
    expect(result.error.hint).toContain("fallow similar-code setup --local");
  });
});

describe("similar-code packets", INSPECT_TIMEOUT, () => {
  it("inspects a pair against the stored snapshot with the real Fallow binary", async () => {
    const output = await recorded();
    const { loaded } = await corpus(output);
    const pair = output.candidates.find(
      (candidate) => candidate.candidate_id === idOf(output, "sumPrices", "totalCost"),
    );
    if (pair === undefined) throw new Error("Missing pair");
    const built = await similarCodeAdapter.packet.build(pair, output, loaded);
    expect(built.truncated).toBe(false);
    expect(built.packet.evidence?.left.source_window).toContain("price");
    expect(built.packet.evidence?.right.source_window).toContain("price");
    expect(built.reviewKey).toBe(pair.review_key);
    expect(similarCodeAdapter.packet.summary(built)).toMatchObject({
      truncated: false,
      windows: 2,
      leftName: pair.left.name,
      rightName: pair.right.name,
    });
    const again = await similarCodeAdapter.packet.build(pair, output, loaded);
    expect(again.fingerprint).toBe(built.fingerprint);
  });

  it("marks the packet truncated when inspect fails closed after an edit", async () => {
    const output = await recorded();
    const { loaded, root } = await corpus(output);
    const pair = output.candidates.find(
      (candidate) => candidate.candidate_id === idOf(output, "sumPrices", "totalCost"),
    );
    if (pair === undefined) throw new Error("Missing pair");
    const file = path.join(root, "src/cart.ts");
    await writeFile(
      file,
      (await readFile(file, "utf8")).replace("total += item.price;", "total += item.price * 2;"),
    );
    const built = await similarCodeAdapter.packet.build(pair, output, loaded);
    expect(built.truncated).toBe(true);
    expect(built.packet.evidence).toBeNull();
    expect(built.packet.omissions).toEqual(["inspect failed (fallow_failed)"]);
  });

  it("marks the packet truncated for a cut window, a missing window or a truncation diagnostic", async () => {
    const output = await recorded();
    const [pair] = output.candidates;
    if (pair === undefined) throw new Error("Empty corpus");
    const side = { callers: [], callees: [], owners: [], tests: [], source_window: "() => 1" };
    const inspect = (
      left: object,
      diagnostics: SimilarCodeInspectOutput["diagnostics"] = [],
    ): SimilarCodeInspectOutput =>
      ({
        packet: {
          candidate_id: pair.candidate_id,
          review_key: pair.review_key,
          availability: pair.enrichment,
          left: { ...side, ...left },
          right: side,
        },
        diagnostics,
      }) as unknown as SimilarCodeInspectOutput;
    expect(pairFromInspect(pair, inspect({})).truncated).toBe(false);
    expect(
      pairFromInspect(pair, inspect({ source_window: "() => {\n/* source window truncated */" }))
        .packet.omissions,
    ).toEqual(["left source window cut"]);
    expect(pairFromInspect(pair, inspect({ source_window: null })).packet.omissions).toEqual([
      "left source window missing",
    ]);
    expect(
      pairFromInspect(
        pair,
        inspect({}, [
          {
            domain: "enrichment",
            code: "FALLOW_SIMILAR_CODE_GRAPH_ENRICHMENT_TRUNCATED",
            message: "cut",
          },
        ]),
      ).truncated,
    ).toBe(true);
  });
});

describe("similar-code policy", () => {
  it("maps a refactor-safe pair with the same responsibility to survivor", () => {
    const decision = decideSimilarCode(
      answers(0.97, 0.96, 0.97, "same-responsibility"),
      false,
      POLICY,
    );
    expect(decision).toMatchObject({
      verdict: "survivor",
      rule: "merge-safe",
      kindData: {
        candidate_worthy: true,
        behaviorally_equivalent: true,
        refactor_safe: true,
        outcome: "same-responsibility",
      },
    });
  });

  it("keeps the contract order: a positive axis without its prerequisite becomes null", () => {
    expect(
      orderAxes({
        candidate_worthy: null,
        behaviorally_equivalent: true,
        refactor_safe: true,
        outcome: "same-responsibility",
      }),
    ).toEqual({
      candidate_worthy: null,
      behaviorally_equivalent: null,
      refactor_safe: null,
      outcome: "same-responsibility",
    });
    const decision = decideSimilarCode(
      answers(0.97, 0.5, 0.99, "same-responsibility"),
      false,
      POLICY,
    );
    expect(decision.kindData).toMatchObject({ behaviorally_equivalent: null, refactor_safe: null });
    expect(decision.verdict).toBe("needs-human-review");
    // A negative answer needs no prerequisite.
    expect(
      decideSimilarCode(answers(0.5, 0.02, 0.01, "related-but-distinct"), false, POLICY).kindData,
    ).toMatchObject({
      candidate_worthy: null,
      behaviorally_equivalent: false,
      refactor_safe: false,
    });
  });

  it("gives null for an axis below its floor, never false", () => {
    const decision = decideSimilarCode(
      answers(0.97, 0.95, 0.93, "same-responsibility"),
      false,
      POLICY,
    );
    expect(decision.kindData).toMatchObject({
      candidate_worthy: true,
      behaviorally_equivalent: true,
      refactor_safe: null,
    });
    expect(decision).toMatchObject({ verdict: "needs-human-review", rule: "uncertain" });
    const strict = configSchema.parse({
      similarCode: { policy: { candidateWorthyFloor: 0.99 } },
    }).similarCode.policy;
    expect(
      decideSimilarCode(answers(0.97, 0.96, 0.97, "same-responsibility"), false, strict).kindData,
    ).toMatchObject({ candidate_worthy: null, behaviorally_equivalent: null, refactor_safe: null });
    expect(
      decideSimilarCode(answers(0.97, 0.96, 0.97, "same-responsibility", 0.5), false, POLICY)
        .kindData,
    ).toMatchObject({ outcome: "needs-human-review" });
  });

  it("gives needs-human-review with unknown axes for truncated evidence", () => {
    const decision = decideSimilarCode(
      answers(0.99, 0.99, 0.99, "same-responsibility"),
      true,
      POLICY,
    );
    expect(decision).toMatchObject({
      verdict: "needs-human-review",
      rule: "truncated-evidence",
      kindData: {
        candidate_worthy: null,
        behaviorally_equivalent: null,
        refactor_safe: null,
        outcome: "needs-human-review",
      },
    });
  });

  it("dismisses an unrelated pair and sends conflicts or missing answers to a person", () => {
    expect(decideSimilarCode(answers(0.05, 0.02, 0.02, "unrelated"), false, POLICY)).toMatchObject({
      verdict: "dismissed",
      rule: "not-a-candidate",
    });
    expect(decideSimilarCode(answers(0.97, 0.3, 0.2, "unrelated"), false, POLICY)).toMatchObject({
      verdict: "needs-human-review",
      rule: "answers-conflict",
    });
    expect(
      decideSimilarCode(answers(0.97, 0.96, 0.97, "intentional-duplication"), false, POLICY),
    ).toMatchObject({ verdict: "needs-human-review", rule: "answers-conflict" });
    const { outcome: _outcome, ...partial } = answers(0.97, 0.96, 0.97, "same-responsibility");
    expect(decideSimilarCode(partial, false, POLICY)).toMatchObject({
      verdict: "needs-human-review",
      rule: "evidence-missing",
    });
  });
});

describe("similar-code pipeline", INSPECT_TIMEOUT, () => {
  it("judges the corpus, writes one Fallow verdict per candidate and passes the Fallow join", async () => {
    const output = await recorded();
    const { loaded, store } = await corpus(output);
    await scanWith(similarCodeAdapter, loaded, store, {});
    const engine = await corpusEngine();
    const judged = await judgeWith(similarCodeAdapter, loaded, store, engine, {
      rejudge: false,
      dryRun: false,
    });
    expect(judged).toMatchObject({ ok: true, data: { errors: 0, pending: 0 } });
    // Each dismissal takes a second call that must agree.
    const unrelated = engine.calls.filter((pair) => pair === "parseUserAgent~parseUserId");
    expect(unrelated).toHaveLength(2);

    const report = await dispatchKind(similarCodeAdapter, {
      options: optionsFor(["report", "--quiet", "--kind", KIND, "--show-dismissed"]),
      loaded,
      store,
      signal: new AbortController().signal,
    });
    expect(report).toMatchObject({ ok: true });
    if (!report.ok) return;
    expect(report.data.human).toContain("Similar-code review");
    expect(report.data.human).toContain("Safe merge candidate");
    expect(report.data.human).toContain("Functions: ");
    expect(report.data.human).toContain("Not worth merging");
    // Survivors make the report exit 1 under the default failOn.
    expect(report.data.exitCode).toBe(1);

    const verdicts = (await readJson(store.verdictsPath)) as ReturnType<
      typeof toSimilarCodeVerdicts
    >;
    expect(verdicts.schema_version).toBe("1");
    expect(verdicts.verdicts.map((verdict) => verdict.candidate_id)).toEqual(
      output.candidates.map((candidate) => candidate.candidate_id),
    );
    const byId = new Map(verdicts.verdicts.map((verdict) => [verdict.candidate_id, verdict]));
    expect(byId.get(idOf(output, "sumPrices", "totalCost"))).toMatchObject({
      candidate_worthy: true,
      behaviorally_equivalent: true,
      refactor_safe: true,
      outcome: "same-responsibility",
    });
    expect(byId.get(idOf(output, "normalizeTags", "tidyNames"))).toMatchObject({
      behaviorally_equivalent: false,
      refactor_safe: false,
      outcome: "needs-human-review",
    });
    expect(byId.get(idOf(output, "parseUserId", "parseUserAgent"))).toMatchObject({
      candidate_worthy: false,
      outcome: "unrelated",
    });
  });

  it("fails the report when the Fallow join rejects the verdicts", async () => {
    const output = await recorded();
    const { loaded, store } = await corpus(output);
    await scanWith(similarCodeAdapter, loaded, store, {});
    // A discovery document that no longer holds the scanned candidates.
    await store.writeJson(store.candidatesPath, {
      ...output,
      candidates: output.candidates.slice(1),
    });
    const validate = similarCodeAdapter.export.validate;
    if (validate === null) throw new Error("Missing join");
    await store.writeJson(store.verdictsPath, {
      schema_version: "1",
      verdicts: [],
    });
    expect(await validate(loaded, store)).toMatchObject({
      ok: false,
      error: {
        code: "fallow_failed",
        message: expect.stringContaining("a verdict is required for every candidate"),
      },
    });
  });

  it("abstains for an unconfirmed dismissal and a pending pair, and keeps a closure", async () => {
    const output = await recorded();
    const { loaded, store } = await corpus(output);
    await scanWith(similarCodeAdapter, loaded, store, {});
    const target = idOf(output, "formatOrderDate", "formatOrderTotal");
    let calls = 0;
    const flip: DecisionEngine = {
      id: "flip",
      evaluate: (request) => {
        if (pairName(request.state) !== "formatOrderDate~formatOrderTotal")
          return Promise.resolve(
            ok({ model: "flip-1", answers: UNCERTAIN, inputTokens: 1, latencyMs: 1 }),
          );
        calls += 1;
        const set =
          calls === 1
            ? answers(0.05, 0.02, 0.02, "unrelated")
            : answers(0.6, 0.5, 0.4, "related-but-distinct", 0.5);
        return Promise.resolve(ok({ model: "flip-1", answers: set, inputTokens: 1, latencyMs: 1 }));
      },
    };
    await judgeWith(similarCodeAdapter, loaded, store, flip, {
      rejudge: false,
      dryRun: false,
      limit: undefined,
    });
    const { records } = await store.readRecords();
    const record = records.find((entry) => entry.finding_id === target);
    expect(record?.decision).toMatchObject({
      verdict: "needs-human-review",
      rule: "dismissal-unconfirmed",
    });

    const closedId = idOf(output, "sumPrices", "totalCost");
    expect(
      await closeWith(
        similarCodeAdapter,
        loaded,
        store,
        closedId,
        "Kept apart for the plugin API.",
      ),
    ).toMatchObject({ ok: true });
    const after = (await store.readRecords()).records;
    const ids = new Set(output.candidates.map((candidate) => candidate.candidate_id));
    const withPending = after.map((entry) =>
      entry.finding_id === idOf(output, "isBlankText", "isEmptyString")
        ? { ...entry, status: "pending" as const, decision: null }
        : entry,
    );
    const byId = new Map(
      toSimilarCodeVerdicts(withPending, ids, output).verdicts.map((verdict) => [
        verdict.candidate_id,
        verdict,
      ]),
    );
    expect(byId.get(target)).toMatchObject({
      candidate_worthy: null,
      behaviorally_equivalent: null,
      refactor_safe: null,
      outcome: "needs-human-review",
    });
    expect(byId.get(closedId)).toMatchObject({
      outcome: "intentional-duplication",
      rationale: "Closed by a person: Kept apart for the plugin API.",
    });
    expect(byId.get(idOf(output, "isBlankText", "isEmptyString"))).toMatchObject({
      outcome: "needs-human-review",
      refactor_safe: null,
    });
  });
});

const checkOptions = (target: string, cwd: string): CheckOptions => ({
  target,
  cwd,
  dryRun: true,
  engine: () =>
    ok({ id: "unused", evaluate: () => Promise.reject(new Error("no call")) } as DecisionEngine),
});

describe("similar-code check", INSPECT_TIMEOUT, () => {
  it("resolves a pair only when a complete discovery no longer reports it", async () => {
    const output = await recorded();
    const { loaded, store, root } = await corpus(output);
    await scanWith(similarCodeAdapter, loaded, store, {});
    const target = idOf(output, "sumPrices", "totalCost");
    const without = output.candidates.filter((candidate) => candidate.candidate_id !== target);

    await writeFile(
      path.join(root, ".discovery.json"),
      JSON.stringify({ ...output, candidates: without }),
    );
    const partial = await checkWith(similarCodeAdapter, loaded, store, checkOptions(target, root));
    expect(partial).toMatchObject({
      ok: true,
      data: {
        report: {
          outcome: "needs-person",
          exit_code: 3,
          results: [{ status: "ambiguous", matches: [] }],
        },
      },
    });

    await writeFile(
      path.join(root, ".discovery.json"),
      JSON.stringify({
        ...output,
        candidates: without,
        completion: { ...output.completion, status: "complete" },
      }),
    );
    const complete = await checkWith(similarCodeAdapter, loaded, store, checkOptions(target, root));
    expect(complete).toMatchObject({
      ok: true,
      data: { report: { outcome: "cleared", exit_code: 0, results: [{ status: "resolved" }] } },
    });
  });

  it("follows a pair whose candidate id changed by its review key", async () => {
    const output = await recorded();
    const { loaded, store, root } = await corpus(output);
    await scanWith(similarCodeAdapter, loaded, store, {});
    const target = idOf(output, "sumPrices", "totalCost");
    const moved = output.candidates.map((candidate) =>
      candidate.candidate_id === target
        ? { ...candidate, candidate_id: `${target}-moved` }
        : candidate,
    );
    await writeFile(
      path.join(root, ".discovery.json"),
      JSON.stringify({ ...output, candidates: moved }),
    );
    const result = await checkWith(similarCodeAdapter, loaded, store, checkOptions(target, root));
    expect(result).toMatchObject({
      ok: true,
      data: {
        report: {
          results: [{ status: "not-assessed", finding_id: `${target}-moved`, stored_id: target }],
        },
      },
    });
  });

  it("treats a fresh pair with one of the functions as a possible match", async () => {
    const output = await recorded();
    const { loaded, store, root } = await corpus(output);
    await scanWith(similarCodeAdapter, loaded, store, {});
    const target = idOf(output, "sumPrices", "totalCost");
    const pair = output.candidates.find((candidate) => candidate.candidate_id === target);
    if (pair === undefined) throw new Error("Missing pair");
    const edited = {
      ...pair,
      candidate_id: "similar-code:candidate:v1:edited",
      review_key: "similar-code:review:v1:edited",
      left: { ...pair.left, path: "src/renamed.ts" },
      right: { ...pair.right, path: "src/other.ts" },
    };
    const fresh = [
      ...output.candidates.filter((candidate) => candidate.candidate_id !== target),
      edited,
    ];
    await writeFile(
      path.join(root, ".discovery.json"),
      JSON.stringify({
        ...output,
        candidates: fresh,
        completion: { ...output.completion, status: "complete" },
      }),
    );
    const result = await checkWith(similarCodeAdapter, loaded, store, checkOptions(target, root));
    expect(result).toMatchObject({
      ok: true,
      data: { report: { results: [{ status: "ambiguous", matches: [edited.candidate_id] }] } },
    });
  });
});

describe("similar-code evaluation corpus", () => {
  it("binds every label to reviewed source and marks no near miss refactor-safe", async () => {
    const output = await recorded();
    const bound = bindPairLabels(output, await labels());
    expect(bound.size).toBe((await labels()).labels.length);
    const expected = new Set([...bound.values()].map((label) => label.expected));
    expect(expected).toEqual(new Set(["equivalent", "near-miss", "unrelated"]));

    const { answers: stub } = await stubAnswers();
    const decisions = new Map<string, StoredDecision>();
    for (const [id, label] of bound) {
      const set = stub[label.id];
      if (set === undefined) throw new Error(`No stub answers for ${label.id}`);
      decisions.set(id, decideSimilarCode(set, false, POLICY));
    }
    const result = evaluatePairs(bound, decisions);
    expect(result).toMatchObject({
      labeled: bound.size,
      judged: bound.size,
      nearMissesMarkedSafe: [],
      wrongSurvivors: [],
      equivalentsDismissed: [],
      survivorRecall: 1,
      unrelatedDismissed: 1,
    });
  });

  it("refuses a label whose reviewed source changed", async () => {
    const output = await recorded();
    const set = await labels();
    const [first, ...rest] = set.labels;
    if (first === undefined) throw new Error("No labels");
    expect(() =>
      bindPairLabels(output, {
        ...set,
        labels: [{ ...first, leftSha256: "0".repeat(64) }, ...rest],
      }),
    ).toThrow(/Reviewed source changed/);
  });
});

const lines = async (file: string): Promise<string[]> => {
  try {
    return (await readFile(file, "utf8")).split("\n").filter((line) => line.length > 0);
  } catch {
    return [];
  }
};

/** Only the sumPrices~totalCost pair, which the stub answers call a survivor. */
const survivorOnly = async (): Promise<SimilarCodeOutput> => {
  const output = await recorded();
  const id = idOf(output, "sumPrices", "totalCost");
  return {
    ...output,
    candidates: output.candidates.filter((candidate) => candidate.candidate_id === id),
  };
};

const SAFE_MERGE = answers(0.97, 0.96, 0.97, "same-responsibility");

/** Answers from `sets` in order; the last one repeats. A string entry is an engine error. */
const sequenceEngine = (
  sets: readonly (Record<string, Answer> | "fail")[],
): DecisionEngine & { calls: number } => {
  const engine = {
    id: "sequence",
    calls: 0,
    evaluate: () => {
      const set = sets[Math.min(engine.calls, sets.length - 1)];
      engine.calls += 1;
      if (set === undefined || set === "fail")
        return Promise.resolve(
          err(verdictError("engine_unavailable", "The engine is unavailable.")),
        );
      return Promise.resolve(ok({ model: "seq-1", answers: set, inputTokens: 900, latencyMs: 1 }));
    },
  };
  return engine;
};

describe("similar-code survivor agreement", INSPECT_TIMEOUT, () => {
  it("keeps a survivor when the second call agrees", async () => {
    const output = await survivorOnly();
    const { loaded, store } = await corpus(output);
    await scanWith(similarCodeAdapter, loaded, store, {});
    const engine = sequenceEngine([SAFE_MERGE]);
    await judgeWith(similarCodeAdapter, loaded, store, engine, { rejudge: false, dryRun: false });
    expect(engine.calls).toBe(2);
    const [record] = (await store.readRecords()).records;
    expect(record?.decision).toMatchObject({ verdict: "survivor", rule: "merge-safe" });
    expect(record?.confirmationAnswers).toBeDefined();
  });

  it("sends a survivor to a person when the second call disagrees, and exports no axes", async () => {
    const output = await survivorOnly();
    const { loaded, store } = await corpus(output);
    await scanWith(similarCodeAdapter, loaded, store, {});
    const engine = sequenceEngine([SAFE_MERGE, answers(0.97, 0.95, 0.93, "same-responsibility")]);
    await judgeWith(similarCodeAdapter, loaded, store, engine, { rejudge: false, dryRun: false });
    const { records } = await store.readRecords();
    expect(records[0]?.decision).toMatchObject({
      verdict: "needs-human-review",
      rule: "survivor-unconfirmed",
    });
    const ids = new Set(output.candidates.map((candidate) => candidate.candidate_id));
    expect(toSimilarCodeVerdicts(records, ids, output).verdicts[0]).toMatchObject({
      candidate_worthy: null,
      behaviorally_equivalent: null,
      refactor_safe: null,
      outcome: "needs-human-review",
    });
    // A disagreement is final for the current evidence: judge does not ask again.
    const again = sequenceEngine([SAFE_MERGE]);
    await judgeWith(similarCodeAdapter, loaded, store, again, { rejudge: false, dryRun: false });
    expect(again.calls).toBe(0);
  });

  it("asks again after a failed second call", async () => {
    const output = await survivorOnly();
    const { loaded, store } = await corpus(output);
    await scanWith(similarCodeAdapter, loaded, store, {});
    await judgeWith(similarCodeAdapter, loaded, store, sequenceEngine([SAFE_MERGE, "fail"]), {
      rejudge: false,
      dryRun: false,
    });
    expect((await store.readRecords()).records[0]?.decision?.rule).toBe("survivor-unconfirmed");
    const again = sequenceEngine([SAFE_MERGE]);
    await judgeWith(similarCodeAdapter, loaded, store, again, { rejudge: false, dryRun: false });
    expect(again.calls).toBe(2);
    expect((await store.readRecords()).records[0]?.decision?.verdict).toBe("survivor");
  });

  it("keeps one call with confirmSurvivors false", async () => {
    const output = await survivorOnly();
    const { loaded, store } = await corpus(output, { similarCode: { confirmSurvivors: false } });
    await scanWith(similarCodeAdapter, loaded, store, {});
    const engine = sequenceEngine([SAFE_MERGE]);
    await judgeWith(similarCodeAdapter, loaded, store, engine, { rejudge: false, dryRun: false });
    expect(engine.calls).toBe(1);
    expect((await store.readRecords()).records[0]?.decision?.verdict).toBe("survivor");
  });

  it("reserves the cost of both calls and states the bound in a dry run", async () => {
    const output = await survivorOnly();
    // Survivor confirmation alone decides the bound, also without dismissal confirmation.
    const { loaded, store } = await corpus(output, { policy: { confirmDismissals: false } });
    await scanWith(similarCodeAdapter, loaded, store, {});
    const dry = await judgeWith(similarCodeAdapter, loaded, store, sequenceEngine([SAFE_MERGE]), {
      rejudge: false,
      dryRun: true,
    });
    if (!dry.ok) throw new Error(dry.error.message);
    expect(dry.data.estimatedUsd).toBeGreaterThan(0);
    expect(dry.data.maxConfirmationUsd).toBe(dry.data.estimatedUsd);

    const single = await corpus(output, {
      policy: { confirmDismissals: false },
      similarCode: { confirmSurvivors: false },
    });
    await scanWith(similarCodeAdapter, single.loaded, single.store, {});
    const none = await judgeWith(
      similarCodeAdapter,
      single.loaded,
      single.store,
      sequenceEngine([SAFE_MERGE]),
      {
        rejudge: false,
        dryRun: true,
      },
    );
    expect(none).toMatchObject({ ok: true, data: { maxConfirmationUsd: 0 } });

    // A cap that covers one call but not two starts no call.
    const engine = sequenceEngine([SAFE_MERGE]);
    const capped = await judgeWith(similarCodeAdapter, loaded, store, engine, {
      rejudge: false,
      dryRun: false,
      maxCostUsd: dry.data.estimatedUsd * 1.5,
    });
    expect(capped).toMatchObject({ ok: true, data: { outcome: "budget-exhausted", judged: 0 } });
    expect(engine.calls).toBe(0);
  });
});

describe("similar-code inspect cache", INSPECT_TIMEOUT, () => {
  it("reuses inspect output across judge and report, and a new scan clears it", async () => {
    const output = await survivorOnly();
    const { loaded, store, root, inspectLog } = await corpus(output);
    const cacheDir = path.join(store.dataDir, "inspect");
    await scanWith(similarCodeAdapter, loaded, store, {});
    await judgeWith(similarCodeAdapter, loaded, store, sequenceEngine([SAFE_MERGE]), {
      rejudge: false,
      dryRun: false,
    });
    expect(await lines(inspectLog)).toHaveLength(1);
    const entries = await readdir(cacheDir);
    expect(entries).toContain("snapshot");
    expect(entries.filter((name) => name.endsWith(".json"))).toHaveLength(1);
    const marker = await readFile(path.join(cacheDir, "snapshot"), "utf8");

    await dispatchKind(similarCodeAdapter, {
      options: optionsFor(["report", "--quiet", "--kind", KIND, "--fail-on", "off"]),
      loaded,
      store,
      signal: new AbortController().signal,
    });
    expect(await lines(inspectLog)).toHaveLength(1);

    // An edit after the scan changes the key, so old evidence is never reused.
    const file = path.join(root, "src/checkout.ts");
    await writeFile(file, `${await readFile(file, "utf8")}\n`);
    await similarCodeAdapter.packet.build(output.candidates[0] ?? never(), output, loaded);
    expect(await lines(inspectLog)).toHaveLength(2);

    // A new scan with another snapshot removes the old entries on the first write.
    const full = await recorded();
    await writeFile(path.join(root, ".discovery.json"), JSON.stringify(full));
    await scanWith(similarCodeAdapter, loaded, store, {});
    await judgeWith(similarCodeAdapter, loaded, store, sequenceEngine([UNCERTAIN]), {
      rejudge: false,
      dryRun: true,
    });
    const after = (await readdir(cacheDir)).filter((name) => name.endsWith(".json"));
    expect(after).toHaveLength(full.candidates.length);
    expect(await readFile(path.join(cacheDir, "snapshot"), "utf8")).not.toBe(marker);
  });

  it("does not write the cache for the fresh discovery of check", async () => {
    const output = await survivorOnly();
    const { loaded, store, root, inspectLog } = await corpus(output);
    const target = output.candidates[0]?.candidate_id ?? never();
    await scanWith(similarCodeAdapter, loaded, store, {});
    // The same pairs in another discovery document: inspect succeeds, but the snapshot differs.
    await writeFile(
      path.join(root, ".discovery.json"),
      JSON.stringify({ ...output, elapsed_ms: output.elapsed_ms + 1 }),
    );
    const checked = await checkWith(similarCodeAdapter, loaded, store, checkOptions(target, root));
    expect(checked).toMatchObject({
      ok: true,
      data: { report: { results: [{ status: "not-assessed" }] } },
    });
    expect(await lines(inspectLog)).toHaveLength(1);
    await expect(readdir(path.join(store.dataDir, "inspect"))).rejects.toThrow(/ENOENT/);
  });
});

const never = (): never => {
  throw new Error("Missing test data");
};

const configured = (config: Record<string, unknown> = {}): LoadedConfig => ({
  config: configSchema.parse(config),
  root: "/project",
  dataDir: "/project/.fallow-verdict",
  configPath: null,
});

describe("confirmed verdicts for each kind", () => {
  it("confirms similar-code dismissals and survivors, security dismissals, and nothing for review", () => {
    const verdicts = (kind: "security" | "review" | "similar-code", config = {}): string[] =>
      kindFor(kind).use((adapter) =>
        [...confirmedVerdicts(adapter, configured(config))].toSorted(),
      );
    expect(verdicts("security")).toEqual(["dismissed"]);
    expect(verdicts("review")).toEqual([]);
    expect(verdicts("similar-code")).toEqual(["dismissed", "survivor"]);
    expect(verdicts("similar-code", { policy: { confirmDismissals: false } })).toEqual([
      "survivor",
    ]);
    expect(verdicts("similar-code", { similarCode: { confirmSurvivors: false } })).toEqual([
      "dismissed",
    ]);
    expect(verdicts("review", { review: { confirmDismissals: true } })).toEqual(["dismissed"]);
  });
});

const boundLine = (kind: "security" | "review" | "similar-code", usd: number): string | null =>
  kindFor(kind).use((adapter) => confirmationBoundLine(adapter.report, usd));

describe("confirmation bound wording", INSPECT_TIMEOUT, () => {
  it("names the confirmation calls of each kind, and review shows no line", () => {
    expect(boundLine("security", 0.001)).toBe(
      "Dismissal confirmation calls can add up to $0.0010.",
    );
    expect(boundLine("similar-code", 0.001)).toBe(
      "Confirmation calls (dismissals and merge recommendations) can add up to $0.0010.",
    );
    // Review confirms nothing by default, so its bound is zero and no line appears.
    expect(kindFor("review").use((adapter) => confirmedVerdicts(adapter, configured()).size)).toBe(
      0,
    );
    expect(boundLine("review", 0)).toBeNull();
  });

  it("uses the similar-code words in a check dry run", async () => {
    const output = await survivorOnly();
    const { loaded, store, root } = await corpus(output);
    await scanWith(similarCodeAdapter, loaded, store, {});
    const target = output.candidates[0]?.candidate_id ?? never();
    const checked = await checkWith(similarCodeAdapter, loaded, store, checkOptions(target, root));
    if (!checked.ok) throw new Error(checked.error.message);
    const human = renderCheckHuman(checked.data, similarCodeAdapter.report);
    expect(human).toContain(
      "Confirmation calls (dismissals and merge recommendations) can add up to",
    );
    expect(human).not.toContain("Dismissal confirmation calls");
  });
});
