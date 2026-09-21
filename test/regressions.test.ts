import { mkdir, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { LoadedConfig } from "../src/config/load.ts";
import type { DecisionEngine } from "../src/engine/types.ts";
import { evaluate, LABELS_SCHEMA } from "../src/eval/metrics.ts";
import type { SecurityFinding } from "../src/fallow/types.ts";
import { buildPacket } from "../src/packet/build.ts";
import { judge, type JudgeOptions } from "../src/pipeline/judge.ts";
import { syncRecords } from "../src/pipeline/scan.ts";
import { decide } from "../src/policy/decide.ts";
import { buildReport } from "../src/report/render.ts";
import { openStore, type Store } from "../src/state/store.ts";
import { verdictError } from "../src/util/errors.ts";
import { err, ok } from "../src/util/result.ts";
import { tokensToUsd } from "../src/util/tokens.ts";
import { toVerdictsFile } from "../src/verdicts/export.ts";
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
} from "./helpers.ts";

const judgeOptions: JudgeOptions = { rejudge: false, dryRun: false };

const dismissedProject = async (): Promise<{
  root: string;
  loaded: LoadedConfig;
  store: Store;
  finding: SecurityFinding;
}> => {
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
    judgeOptions,
  );
  return { root, loaded, store, finding };
};

describe("stale verdict safety", () => {
  it.each<Partial<JudgeOptions>>([
    { maxCostUsd: 0 },
    { limit: 0 },
    { signal: AbortSignal.abort() },
  ])("does not export stale dismissals when judgment stops: %j", async (options) => {
    const { root, loaded, store, finding } = await dismissedProject();
    await writeFile(path.join(root, SINK_FILE), `${SINK_SOURCE}\n// changed evidence\n`);

    await judge(
      loaded,
      store,
      mockEngine(() => SAFE_MITIGATED),
      {
        ...judgeOptions,
        ...options,
      },
    );

    const { records } = await store.readRecords();
    expect(toVerdictsFile(records, new Set([finding.finding_id])).verdicts).toEqual([]);
    expect(buildReport(records).summary.dismissed).toBe(0);
  });

  it("does not report a dismissal after a rescan changes candidate evidence", async () => {
    const { store, finding } = await dismissedProject();
    const changed = makeFinding({ ...finding, evidence: "The input now bypasses validation" });

    await syncRecords(store, makeOutput([changed]), false);

    const { records } = await store.readRecords();
    expect(buildReport(records).summary.dismissed).toBe(0);
    expect(toVerdictsFile(records, new Set([finding.finding_id])).verdicts).toEqual([]);
  });
});

describe("incomplete evidence safety", () => {
  it("does not dismiss when a referenced source file is unreadable", async () => {
    const root = await makeProject();
    const finding = makeFinding({
      trace: [{ path: "src/missing.ts", line: 1, col: 0, role: "untrusted-source" }],
    });
    const loaded = makeLoaded(root);
    const built = await buildPacket(finding, makeOutput([finding]), {
      root,
      ...loaded.config.packet,
    });

    expect(built.unreadable).toContain("src/missing.ts");
    expect(decide(answersFor(SAFE_MITIGATED), built, loaded.config.policy).verdict).toBe(
      "needs-human-review",
    );
  });

  it("does not treat an out-of-range sink location as visible evidence", async () => {
    const root = await makeProject();
    const loaded = makeLoaded(root);
    const original = makeFinding();
    const finding = makeFinding({
      trace: [],
      candidate: { ...original.candidate, sink: { ...original.candidate.sink, line: 999 } },
    });
    const built = await buildPacket(finding, makeOutput([finding]), {
      root,
      ...loaded.config.packet,
    });

    expect(decide(answersFor(SAFE_MITIGATED), built, loaded.config.policy).verdict).toBe(
      "needs-human-review",
    );
  });
});

describe("evaluation status safety", () => {
  it.each(["pending", "error", "resolved"] as const)(
    "does not score a historical decision on a %s record",
    async (status) => {
      const { store, finding } = await dismissedProject();
      const { records } = await store.readRecords();
      const report = evaluate(
        records.map((record) => ({ ...record, status })),
        {
          schema_version: LABELS_SCHEMA,
          labels: [{ finding_id: finding.finding_id, expected: "safe" }],
        },
      );

      expect(report.judged).toBe(0);
      expect(report.unjudged).toBe(1);
      expect(report.dismissPrecision).toBeNull();
      expect(report.calibrationError).toBeNull();
    },
  );
});

describe("run accounting safety", () => {
  it("counts completed requests while their records are being persisted", async () => {
    const root = await makeProject();
    const loaded = makeLoaded(root, { engine: { concurrency: 2 } });
    const store = openStore(loaded.dataDir);
    const findings = ["one", "two", "three"].map((name) =>
      makeFinding({ finding_id: `security:${name}` }),
    );
    await store.writeJson(store.candidatesPath, makeOutput(findings));
    await syncRecords(store, makeOutput(findings), false);
    const plan = await judge(
      loaded,
      store,
      mockEngine(() => SAFE_MITIGATED),
      {
        ...judgeOptions,
        dryRun: true,
      },
    );
    if (!plan.ok) throw new Error(plan.error.message);
    const perRequest = plan.data.estimatedUsd / findings.length;
    const maxCostUsd = perRequest * 2.01;
    let writes = 0;
    const delayedStore: Store = {
      ...store,
      writeRecord: async (record): Promise<void> => {
        writes += 1;
        if (writes === 2) await new Promise<void>((resolve) => setTimeout(resolve, 50));
        await store.writeRecord(record);
      },
    };
    let calls = 0;
    const engine: DecisionEngine = {
      id: "mock",
      evaluate: async () => {
        calls += 1;
        return ok({
          model: "mock-1",
          answers: answersFor(SAFE_MITIGATED),
          inputTokens: Math.floor(perRequest / tokensToUsd(1)),
          latencyMs: 1,
        });
      },
    };

    const result = await judge(loaded, delayedStore, engine, { ...judgeOptions, maxCostUsd });

    expect(calls).toBe(2);
    expect(result).toMatchObject({ ok: true, data: { outcome: "budget-exhausted" } });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.data.costUsd).toBeLessThanOrEqual(maxCostUsd);
  });

  it("reevaluates unchanged evidence when the configured model changes", async () => {
    const { root, store } = await dismissedProject();
    const engine = mockEngine(() => SAFE_MITIGATED);

    const result = await judge(
      makeLoaded(root, { engine: { model: "different-model" } }),
      store,
      engine,
      judgeOptions,
    );

    expect(engine.calls).toBe(1);
    expect(result).toMatchObject({ ok: true, data: { judged: 1, upToDate: 0 } });
  });

  it("does not mark a run successful after a non-authentication engine failure", async () => {
    const { loaded, store } = await dismissedProject();
    const engine: DecisionEngine = {
      id: "broken",
      evaluate: async () => err(verdictError("engine_rejected", "Unknown model")),
    };

    const result = await judge(loaded, store, engine, { ...judgeOptions, rejudge: true });

    expect(result).toMatchObject({ ok: true, data: { outcome: "error" } });
  });
});

describe("store lock safety", () => {
  it("does not steal a fresh lock while its owner file is still being written", async () => {
    const root = await makeProject();
    const store = openStore(path.join(root, ".fallow-verdict"));
    await mkdir(path.join(store.dataDir, ".lock"), { recursive: true });

    const result = await store.lock();

    expect(result).toMatchObject({ ok: false, error: { code: "state_locked" } });
    if (result.ok) await result.data();
  });

  it("does not steal an old lock from a process that is still running", async () => {
    const root = await makeProject();
    const store = openStore(path.join(root, ".fallow-verdict"));
    const first = await store.lock();
    if (!first.ok) throw new Error(first.error.message);
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(path.join(store.dataDir, ".lock"), old, old);

    try {
      expect(await store.lock()).toMatchObject({
        ok: false,
        error: { code: "state_locked" },
      });
    } finally {
      await first.data();
    }
  });
});
