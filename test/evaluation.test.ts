import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { configSchema } from "../src/config/schema.ts";
import type { DecisionEngine, EvaluateRequest } from "../src/engine/types.ts";
import { compareQuestions, type ComparisonCase } from "../src/eval/comparison.ts";
import { prepareCorpus } from "../src/eval/corpus.ts";
import { evaluate, labelsSchema, LABELS_SCHEMA } from "../src/eval/metrics.ts";
import { buildPacket } from "../src/packet/build.ts";
import { judge } from "../src/pipeline/judge.ts";
import { syncRecords } from "../src/pipeline/scan.ts";
import { QUESTIONS } from "../src/questions/catalog.ts";
import { questionsFor } from "../src/questions/category.ts";
import { openStore } from "../src/state/store.ts";
import { err, ok } from "../src/util/result.ts";
import {
  answersFor,
  makeFinding,
  makeLoaded,
  makeOutput,
  makeProject,
  mockEngine,
  SAFE_MITIGATED,
  SINK_FILE,
  SINK_SOURCE,
  VULNERABLE,
} from "./helpers.ts";

const config = configSchema.parse({});
const model = "jev-1.13.0";
const setup = async (): Promise<{
  cases: ComparisonCase[];
  engine: DecisionEngine;
  requests: EvaluateRequest[];
}> => {
  const root = await makeProject();
  const finding = makeFinding();
  const built = await buildPacket(finding, makeOutput([finding]), { root, ...config.packet });
  const requests: EvaluateRequest[] = [];
  const engine: DecisionEngine = {
    id: "test",
    evaluate: async (request) => {
      requests.push(request);
      return ok({ model, answers: answersFor(SAFE_MITIGATED), inputTokens: 1000, latencyMs: 1 });
    },
  };
  return {
    cases: [{ id: SINK_FILE, expected: "safe", mustReview: false, built }],
    engine,
    requests,
  };
};
const options = {
  variants: [
    { id: "baseline", questions: () => QUESTIONS },
    { id: "candidate", questions: questionsFor },
  ],
  model,
  policy: config.policy,
  repeats: 3,
  maxCostUsd: 1,
  dryRun: false,
};

describe("evaluation label integrity", () => {
  it("withholds aggregate rates for partial coverage while retaining known missed vulnerabilities", async () => {
    const root = await makeProject();
    const loaded = makeLoaded(root);
    const store = openStore(loaded.dataDir);
    const finding = makeFinding();
    const output = makeOutput([finding]);
    await store.writeJson(store.candidatesPath, output);
    await syncRecords(store, output, false);
    await judge(
      loaded,
      store,
      mockEngine(() => SAFE_MITIGATED),
      {
        rejudge: false,
        dryRun: false,
      },
    );
    const report = evaluate((await store.readRecords()).records, {
      schema_version: LABELS_SCHEMA,
      labels: [
        { finding_id: finding.finding_id, expected: "vulnerable" },
        { finding_id: "not-yet-judged", expected: "safe" },
      ],
    });
    expect(report).toMatchObject({
      judged: 1,
      unjudged: 1,
      missedVulnerabilities: [finding.finding_id],
      dismissPrecision: null,
      survivorRecall: null,
      noiseRemoved: null,
      reviewRate: null,
      calibrationError: null,
    });
  });

  it("rejects empty and duplicate or conflicting labels", () => {
    expect(labelsSchema.safeParse({ schema_version: LABELS_SCHEMA, labels: [] }).success).toBe(
      false,
    );
    expect(
      labelsSchema.safeParse({
        schema_version: LABELS_SCHEMA,
        labels: [
          { finding_id: "same", expected: "safe" },
          { finding_id: "same", expected: "vulnerable" },
        ],
      }).success,
    ).toBe(false);
  });

  it("binds corpus labels to source bytes and candidate semantics", async () => {
    const root = await makeProject();
    const finding = makeFinding();
    const label = {
      path: SINK_FILE,
      category: finding.category,
      callee: finding.candidate.sink.callee,
      sourceSha256: createHash("sha256").update(SINK_SOURCE).digest("hex"),
      expected: "safe",
      rationale: "test-only label",
      threatAssumptions: "external input",
    };
    expect(
      (
        await prepareCorpus(
          makeOutput([finding]),
          { [SINK_FILE]: label },
          { root, ...config.packet },
        )
      ).cases,
    ).toHaveLength(1);
    await expect(
      prepareCorpus(
        makeOutput([makeFinding({ category: "ssrf" })]),
        { [SINK_FILE]: label },
        { root, ...config.packet },
      ),
    ).rejects.toThrow("semantics changed");
    await expect(
      prepareCorpus(
        makeOutput([finding]),
        { [SINK_FILE]: { ...label, sourceSha256: "0".repeat(64) } },
        { root, ...config.packet },
      ),
    ).rejects.toThrow("source changed");
  });
});

describe("paired comparison", () => {
  it("requires an artifact destination before a live comparison can request credentials", () => {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("../scripts/compare-questions.ts", import.meta.url))],
      { encoding: "utf8", env: { ...process.env, TYPESAFE_API_KEY: "" }, timeout: 15_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Live comparisons require --output to preserve answers for review.",
    );
    expect(result.stderr).not.toContain("Set TYPESAFE_API_KEY");
    expect(result.stdout).toBe("");
  });

  it("identifies dismissed vulnerabilities even when every scheduled request succeeds", async () => {
    const prepared = await setup();
    const report = await compareQuestions({
      ...options,
      ...prepared,
      cases: prepared.cases.map((item) => ({ ...item, expected: "vulnerable" })),
    });
    expect(report.complete).toBe(true);
    for (const summary of report.summaries) {
      expect(summary).toMatchObject({
        complete: true,
        unsafeDismissals: [SINK_FILE],
        dismissPrecision: 0,
        survivorRecall: 0,
        reviewGuardMisses: [],
      });
    }
  });

  it.each([
    { verdict: "survivor", probabilities: VULNERABLE },
    { verdict: "dismissed", probabilities: SAFE_MITIGATED },
  ])("flags a required review that was instead $verdict", async ({ verdict, probabilities }) => {
    const prepared = await setup();
    const engine: DecisionEngine = {
      id: "review-guard-miss",
      evaluate: async () =>
        ok({ model, answers: answersFor(probabilities), inputTokens: 1000, latencyMs: 1 }),
    };
    const report = await compareQuestions({
      ...options,
      ...prepared,
      engine,
      cases: prepared.cases.map((item) => ({ ...item, mustReview: true })),
    });
    expect(report.complete).toBe(true);
    expect(report.observations.every((row) => row.decision?.verdict === verdict)).toBe(true);
    for (const summary of report.summaries) {
      expect(summary.reviewGuardMisses).toEqual([SINK_FILE]);
    }
  });

  it("reports repeat instability separately for each variant", async () => {
    const prepared = await setup();
    let calls = 0;
    const engine: DecisionEngine = {
      id: "unstable",
      evaluate: async () => {
        const round = Math.floor(calls / options.variants.length);
        calls += 1;
        return ok({
          model,
          answers: answersFor(round % 2 === 0 ? SAFE_MITIGATED : VULNERABLE),
          inputTokens: 1000,
          latencyMs: 1,
        });
      },
    };
    const report = await compareQuestions({ ...options, ...prepared, engine });
    expect(report.complete).toBe(true);
    expect(
      report.summaries.map(({ variant, verdictFlips }) => ({ variant, verdictFlips })),
    ).toEqual([
      { variant: "baseline", verdictFlips: [SINK_FILE] },
      { variant: "candidate", verdictFlips: [SINK_FILE] },
    ]);
  });

  it("retains a successful observation but withholds aggregate rates after the next request fails", async () => {
    const prepared = await setup();
    let calls = 0;
    const engine: DecisionEngine = {
      id: "interrupted-pair",
      evaluate: async () => {
        calls += 1;
        return calls === 1
          ? ok({ model, answers: answersFor(SAFE_MITIGATED), inputTokens: 1000, latencyMs: 1 })
          : err({ code: "engine_timeout", message: "timeout after first result" });
      },
    };
    const report = await compareQuestions({ ...options, ...prepared, engine });
    expect(report).toMatchObject({ complete: false, stopError: { code: "engine_timeout" } });
    expect(report.observations).toMatchObject([
      { variant: "baseline", decision: { verdict: "dismissed" }, error: null },
      { variant: "candidate", decision: null, error: { code: "engine_timeout" } },
    ]);
    expect(report.costUsd).toBeGreaterThan(0);
    expect(calls).toBe(report.observations.length);
    for (const summary of report.summaries) {
      expect(summary).toMatchObject({
        complete: false,
        dismissPrecision: null,
        survivorRecall: null,
        noiseRemoved: null,
        reviewRate: null,
      });
    }
  });

  it("makes fresh requests on identical evidence and alternates question variants", async () => {
    const prepared = await setup();
    const report = await compareQuestions({ ...options, ...prepared });
    expect(prepared.requests).toHaveLength(options.repeats * options.variants.length);
    expect(report.complete).toBe(true);
    expect(new Set(report.observations.map((row) => row.packetHash)).size).toBe(1);
    expect(report.observations.map((row) => row.variant)).toEqual([
      "baseline",
      "candidate",
      "candidate",
      "baseline",
      "baseline",
      "candidate",
    ]);
    expect(JSON.stringify(prepared.requests)).not.toContain('"expected"');
    expect(JSON.stringify(prepared.requests)).not.toContain('"mustReview"');
  });

  it("does not report favorable aggregate metrics after an interrupted comparison", async () => {
    const prepared = await setup();
    const report = await compareQuestions({ ...options, ...prepared, maxCostUsd: 0.000001 });
    expect(report.complete).toBe(false);
    expect(report.stopError?.code).toBe("budget_exhausted");
    expect(report.summaries.every((summary) => summary.noiseRemoved === null)).toBe(true);
    expect(prepared.requests).toHaveLength(0);
  });

  it("rejects mixed model versions and transport failures", async () => {
    const prepared = await setup();
    const mismatch: DecisionEngine = {
      id: "wrong-version",
      evaluate: async () =>
        ok({
          model: "jev-9.0.0",
          answers: answersFor(SAFE_MITIGATED),
          inputTokens: 1000,
          latencyMs: 1,
        }),
    };
    const report = await compareQuestions({ ...options, ...prepared, engine: mismatch });
    expect(report.complete).toBe(false);
    expect(report.observations[0]?.decision).toBeNull();
    const broken: DecisionEngine = {
      id: "broken",
      evaluate: async () => err({ code: "engine_timeout", message: "timeout" }),
    };
    expect(await compareQuestions({ ...options, ...prepared, engine: broken })).toMatchObject({
      complete: false,
      stopError: { code: "engine_timeout" },
    });
  });

  it("dry-runs without requests and rejects model aliases", async () => {
    const prepared = await setup();
    const report = await compareQuestions({ ...options, ...prepared, dryRun: true });
    expect(report.estimatedUsd).toBeGreaterThan(0);
    expect(prepared.requests).toHaveLength(0);
    await expect(
      compareQuestions({ ...options, ...prepared, model: "jev-latest" }),
    ).rejects.toThrow("pinned");
  });
});
