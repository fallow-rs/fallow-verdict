import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { parseCli, type CliOptions } from "../src/cli/args.ts";
import { dispatchKind, unsupportedOption } from "../src/cli/main.ts";
import type { LoadedConfig } from "../src/config/load.ts";
import type { DecisionEngine } from "../src/engine/types.ts";
import type { AnalysisAdapter, BuiltEvidence } from "../src/kinds/adapter.ts";
import { judge, judgeWith } from "../src/pipeline/judge.ts";
import { scanWith, syncRecords } from "../src/pipeline/scan.ts";
import type { KindPresentation } from "../src/report/render.ts";
import {
  locationSchema,
  recordSchema,
  runSchema,
  type FindingRecord,
  type Location,
} from "../src/state/schema.ts";
import { openStore, type Store } from "../src/state/store.ts";
import { verdictError } from "../src/util/errors.ts";
import { err, ok } from "../src/util/result.ts";
import {
  makeFinding,
  makeLoaded,
  makeOutput,
  makeProject,
  mockEngine,
  VULNERABLE,
} from "./helpers.ts";

/** A test-only kind: pairs of similar functions, with two locations and no Fallow severity. */
type Pair = { id: string; a: Location; b: Location };
type PairOutput = { pairs: Pair[] };
type PairPacket = BuiltEvidence & { packet: { pair: Pair } };

const PAIR_KIND = "test-pairs";

const pairOutputSchema = z.object({
  pairs: z.array(z.object({ id: z.string(), a: locationSchema, b: locationSchema })),
});

const PAIRS: PairOutput = {
  pairs: [
    {
      id: "pair:low",
      a: { path: "src/a.ts", line: 1, col: 0 },
      b: { path: "src/b.ts", line: 9, col: 2 },
    },
    {
      id: "pair:first",
      a: { path: "src/c.ts", line: 3, col: null },
      b: { path: "src/d.ts", line: 4, col: null },
    },
  ],
};

const pairPresentation: KindPresentation = {
  title: "Pair review",
  intro: "Fallow found these pairs.",
  survivor: {
    heading: "Distinct pairs",
    label: "Distinct pair",
    count: "distinct pairs",
    note: "Jev considers these functions different.",
  },
  describe: (_record, decision) => ({
    facts: [`Outcome: ${String(decision.kindData?.["outcome"] ?? "none")}`],
    explanation: null,
    estimate: `Model estimate of equivalence: ${decision.probabilities["same"] ?? 0}.`,
    suggestion: null,
  }),
};

const pairAdapter: AnalysisAdapter<PairOutput, Pair, PairPacket> = {
  kind: PAIR_KIND,
  scan: {
    run: () => Promise.resolve(ok(PAIRS)),
    parse: (value) => {
      const parsed = pairOutputSchema.safeParse(value);
      return parsed.success
        ? ok(parsed.data)
        : err(verdictError("state_corrupt", "Invalid pair output."));
    },
    candidates: (output) => output.pairs,
  },
  identity: (pair) => ({
    finding_id: pair.id,
    locations: [pair.a, pair.b],
    category: null,
    severity: null,
  }),
  match: (pair) => pair.id,
  priority: (record) => (record.finding_id === "pair:first" ? 0 : 1),
  packet: {
    build: (pair) =>
      Promise.resolve({
        fingerprint: `fingerprint:${pair.id}`,
        stateTokens: 10,
        packet: { pair },
        truncated: false,
      }),
    summary: (built) => ({ truncated: built.truncated, bodies: 2 }),
  },
  questions: {
    version: "pairs-1",
    for: () => ({
      same: {
        type: "noul",
        instructions: "Do both functions return the same result for every input?",
        criteria: { true: "Same result", false: "Different result" },
      },
    }),
    hash: () => "pairs-hash",
  },
  policy: (answers) => {
    const same = answers["same"]?.type === "noul" ? answers["same"].probability : 0;
    return {
      verdict: same >= 0.9 ? "dismissed" : "survivor",
      rule: same >= 0.9 ? "equivalent" : "distinct",
      confidence: Math.max(same, 1 - same),
      probabilities: { same },
      impact: null,
      fixDirection: null,
      dismissalReason: null,
      reason: "Test policy.",
      kindData: { outcome: same >= 0.9 ? "merge" : "keep" },
    };
  },
  report: pairPresentation,
  supports: { questionProfile: false, eval: false },
  export: {
    verdicts: (records, candidateIds) => ({
      verdicts: records
        .filter((record) => candidateIds.has(record.finding_id))
        .map((record) => ({
          id: record.finding_id,
          verdict: record.decision?.verdict ?? null,
          outcome: record.decision?.kindData?.["outcome"] ?? null,
        })),
    }),
    validate: null,
  },
};

const pairEngine = (same: number): DecisionEngine & { order: string[] } => {
  const engine = {
    id: "pair-stub",
    order: [] as string[],
    evaluate: (request: { state: unknown }) => {
      engine.order.push((request.state as { pair: Pair }).pair.id);
      return Promise.resolve(
        ok({
          model: "pair-stub-1",
          answers: { same: { type: "noul", probability: same } as const },
          inputTokens: 100,
          latencyMs: 1,
        }),
      );
    },
  };
  return engine;
};

/** Every file under `dir` except the `kinds/` subtree, with its content. */
const snapshot = async (dir: string): Promise<Record<string, string>> => {
  const files: Record<string, string> = {};
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    const relative = path.relative(dir, file);
    if (relative.startsWith(`kinds${path.sep}`)) continue;
    files[relative] = await readFile(file, "utf8");
  }
  return files;
};

const optionsFor = (argv: string[]): CliOptions => {
  const parsed = parseCli(argv);
  if (!parsed.ok || parsed.data.kind !== "command") throw new Error("Invalid test arguments");
  return parsed.data.options;
};

const securityState = async (): Promise<{ loaded: LoadedConfig; store: Store }> => {
  const root = await makeProject();
  const loaded = makeLoaded(root);
  const store = openStore(loaded.dataDir, "security");
  const output = makeOutput([makeFinding()]);
  await store.writeJson(store.candidatesPath, output);
  await syncRecords(store, output, false);
  await judge(
    loaded,
    store,
    mockEngine(() => VULNERABLE),
    { rejudge: false, dryRun: false },
  );
  return { loaded, store };
};

describe("a second analysis kind", () => {
  it("scans, judges, reports and exports without touching security state", async () => {
    const { loaded, store: security } = await securityState();
    const before = await snapshot(loaded.dataDir);
    const store = openStore(loaded.dataDir, PAIR_KIND);
    expect(store.dataDir).toBe(path.join(loaded.dataDir, "kinds", PAIR_KIND));

    const scanned = await scanWith(pairAdapter, loaded, store, {});
    expect(scanned).toMatchObject({ ok: true, data: { candidates: 2, added: 2, resolved: 0 } });

    const engine = pairEngine(0.95);
    const judged = await judgeWith(pairAdapter, loaded, store, engine, {
      rejudge: false,
      dryRun: false,
    });
    expect(judged).toMatchObject({ ok: true, data: { judged: 2, errors: 0 } });
    // The adapter priority orders the budget, not a security severity.
    expect([...new Set(engine.order)]).toEqual(["pair:first", "pair:low"]);
    // Each dismissal takes a second call that must agree.
    expect(engine.order).toHaveLength(4);

    const { records, corrupt } = await store.readRecords();
    expect(corrupt).toEqual([]);
    const low = records.find((record) => record.finding_id === "pair:low");
    expect(low).toMatchObject({
      kind: PAIR_KIND,
      path: "src/a.ts",
      line: 1,
      severity: null,
      locations: PAIRS.pairs[0] && [PAIRS.pairs[0].a, PAIRS.pairs[0].b],
      evidence: { truncated: false, bodies: 2 },
      decision: { verdict: "dismissed", kindData: { outcome: "merge" } },
    });

    const report = await dispatchKind(pairAdapter, {
      options: optionsFor(["report", "--quiet", "--show-dismissed"]),
      loaded,
      store,
      signal: new AbortController().signal,
    });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.data.exitCode).toBe(0);
    expect(report.data.human).toContain("Pair review");
    expect(report.data.human).toContain("src/a.ts:1:0, src/b.ts:9:2");
    expect(report.data.human).toContain("Outcome: merge");
    expect(report.data.human).not.toContain("severity");

    expect(await store.readJson(store.verdictsPath)).toMatchObject({
      ok: true,
      data: {
        verdicts: [
          { id: "pair:first", verdict: "dismissed", outcome: "merge" },
          { id: "pair:low", verdict: "dismissed", outcome: "merge" },
        ],
      },
    });
    const markdown = await readFile(store.reportPath, "utf8");
    expect(markdown).toContain("# Pair review");

    const runs = await readdir(path.join(store.dataDir, "runs"));
    expect(runs).toHaveLength(1);
    const run = runSchema.parse(
      JSON.parse(await readFile(path.join(store.dataDir, "runs", runs[0] ?? ""), "utf8")),
    );
    expect(run.kind).toBe(PAIR_KIND);

    // Security state is byte-for-byte unchanged and still reports its own finding.
    expect(await snapshot(loaded.dataDir)).toEqual(before);
    const securityRecords = await security.readRecords();
    expect(securityRecords.records.map((record) => record.kind)).toEqual(["security"]);
    expect(securityRecords.corrupt).toEqual([]);
  });

  it("keeps kinds apart when a record reaches the wrong directory", async () => {
    const root = await makeProject();
    const loaded = makeLoaded(root);
    const store = openStore(loaded.dataDir, PAIR_KIND);
    await scanWith(pairAdapter, loaded, store, {});
    const [record] = (await store.readRecords()).records;
    if (record === undefined) throw new Error("Missing record");

    const security = openStore(loaded.dataDir, "security");
    await expect(security.writeRecord(record)).rejects.toThrow(/test-pairs record/);
    const mismatch = { ok: false, error: { code: "state_corrupt" } };
    expect(await scanWith(pairAdapter, loaded, security, {})).toMatchObject(mismatch);
    expect(
      await judgeWith(pairAdapter, loaded, security, pairEngine(0.5), {
        rejudge: false,
        dryRun: true,
      }),
    ).toMatchObject(mismatch);
    for (const command of ["status", "report"]) {
      const outcome = await dispatchKind(pairAdapter, {
        options: optionsFor([command, "--quiet"]),
        loaded,
        store: security,
        signal: new AbortController().signal,
      });
      expect(outcome).toMatchObject(mismatch);
    }

    const findingsDir = path.join(store.dataDir, "findings");
    const [name] = await readdir(findingsDir);
    if (name === undefined) throw new Error("Missing record file");
    await writeFile(path.join(findingsDir, name), JSON.stringify({ ...record, kind: "security" }));
    expect((await store.readRecords()).corrupt).toEqual([name]);
  });

  it("rejects --question-profile and eval for a kind without them", () => {
    const profile = unsupportedOption(
      pairAdapter,
      optionsFor(["run", "--question-profile", "category"]),
    );
    expect(profile).toMatchObject({ code: "config_invalid" });
    expect(profile?.message).toContain("--question-profile");
    expect(profile?.message).toContain(PAIR_KIND);

    expect(
      unsupportedOption(pairAdapter, optionsFor(["eval", "--labels", "x.json"])),
    ).toMatchObject({ code: "config_invalid" });
    expect(unsupportedOption(pairAdapter, optionsFor(["run"]))).toBeNull();
  });
});

describe("state compatibility", () => {
  it("loads a run record without a kind as a security run", () => {
    const legacy = {
      schema_version: "fallow-verdict-run/v1",
      runId: "20260923000000-abcd1234",
      command: "judge",
      startedAt: "2026-09-23T00:00:00.000Z",
      completedAt: null,
      outcome: "done",
      engine: "jev",
      stats: { judged: 0, skipped: 0, errors: 0, inputTokens: 0, costUsd: 0 },
    };
    expect(runSchema.parse(legacy).kind).toBe("security");
  });

  it.each([
    ["a null severity", { severity: null }],
    ["evidence without the security fields", { evidence: { truncated: false } }],
  ])("reads a security record with %s as corrupt", async (_case, change) => {
    const { loaded, store } = await securityState();
    const findingsDir = path.join(loaded.dataDir, "findings");
    const [name] = await readdir(findingsDir);
    if (name === undefined) throw new Error("Missing record file");
    const file = path.join(findingsDir, name);
    const { kind: _kind, ...legacy } = JSON.parse(await readFile(file, "utf8")) as FindingRecord;
    for (const record of [legacy, { ...legacy, kind: "security" }]) {
      await writeFile(file, JSON.stringify({ ...record, ...change }));
      expect(await store.readRecords()).toMatchObject({ records: [], corrupt: [name] });
    }
  });

  it("keeps the security record layout: one location and a severity", async () => {
    const { store } = await securityState();
    const [record] = (await store.readRecords()).records;
    const stored: FindingRecord | undefined = record;
    expect(stored).toBeDefined();
    expect(stored).not.toHaveProperty("locations");
    expect(recordSchema.parse(stored)).toMatchObject({
      severity: "high",
      path: "src/routes/user.ts",
    });
  });
});
