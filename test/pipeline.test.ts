import { writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { evaluate, LABELS_SCHEMA } from "../src/eval/metrics.ts";
import { judge } from "../src/pipeline/judge.ts";
import { syncRecords } from "../src/pipeline/scan.ts";
import { buildReport } from "../src/report/render.ts";
import { openStore } from "../src/state/store.ts";
import { verdictError } from "../src/util/errors.ts";
import { err } from "../src/util/result.ts";
import { toVerdictsFile } from "../src/verdicts/export.ts";
import {
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

const judgeOptions = { rejudge: false, dryRun: false };

const setup = async (findings = [makeFinding()]) => {
  const root = await makeProject();
  const loaded = makeLoaded(root);
  const store = openStore(loaded.dataDir);
  const output = makeOutput(findings);
  await store.writeJson(store.candidatesPath, output);
  await syncRecords(store, output, false);
  return { root, loaded, store, output };
};

describe("judge", () => {
  it("records a verdict and does not pay twice for unchanged evidence", async () => {
    const { loaded, store } = await setup();
    const engine = mockEngine(() => VULNERABLE);

    const first = await judge(loaded, store, engine, judgeOptions);
    const second = await judge(loaded, store, engine, judgeOptions);

    expect(first).toMatchObject({ ok: true, data: { judged: 1, upToDate: 0 } });
    expect(second).toMatchObject({ ok: true, data: { judged: 0, upToDate: 1 } });
    expect(engine.calls).toBe(1);
  });

  it("judges again when the code behind a verdict changes, and keeps the history", async () => {
    const { root, loaded, store } = await setup();
    await judge(
      loaded,
      store,
      mockEngine(() => VULNERABLE),
      judgeOptions,
    );

    await writeFile(path.join(root, SINK_FILE), SINK_SOURCE.replace("${id}", "${Number(id)}"));
    await judge(
      loaded,
      store,
      mockEngine(() => SAFE_MITIGATED),
      judgeOptions,
    );

    const [record] = (await store.readRecords()).records;
    expect(record?.decision?.verdict).toBe("dismissed");
    expect(record?.history.map((entry) => entry.verdict)).toEqual(["survivor", "dismissed"]);
  });

  it("estimates cost without calling the engine on a dry run", async () => {
    const { loaded, store } = await setup();
    const engine = mockEngine(() => VULNERABLE);
    const result = await judge(loaded, store, engine, { ...judgeOptions, dryRun: true });
    expect(engine.calls).toBe(0);
    expect(result.ok && result.data.estimatedUsd).toBeGreaterThan(0);
  });

  it("stops before passing the cost cap and leaves the rest pending", async () => {
    const findings = [1, 2, 3].map((index) =>
      makeFinding({ finding_id: `security:${index}`, severity: "medium" }),
    );
    const { store } = await setup(findings);
    const loaded = makeLoaded(path.dirname(store.dataDir), { engine: { concurrency: 1 } });
    const plan = await judge(
      loaded,
      store,
      mockEngine(() => VULNERABLE),
      { ...judgeOptions, dryRun: true },
    );
    const perCandidate = (plan.ok ? plan.data.estimatedUsd : 0) / findings.length;

    const result = await judge(
      loaded,
      store,
      mockEngine(() => VULNERABLE),
      {
        ...judgeOptions,
        maxCostUsd: perCandidate * 1.01,
      },
    );
    expect(result).toMatchObject({ ok: true, data: { outcome: "budget-exhausted", judged: 1 } });
    expect(buildReport((await store.readRecords()).records).summary.pending).toBe(2);
  });

  it("marks a candidate errored when the engine fails, so the next run retries it", async () => {
    const { loaded, store } = await setup();
    const broken = {
      id: "broken",
      evaluate: () => Promise.resolve(err(verdictError("engine_rejected", "nope"))),
    };
    expect(await judge(loaded, store, broken, judgeOptions)).toMatchObject({
      ok: true,
      data: { errors: 1 },
    });

    const engine = mockEngine(() => VULNERABLE);
    await judge(loaded, store, engine, judgeOptions);
    expect(engine.calls).toBe(1);
  });
});

describe("syncRecords", () => {
  it("resolves candidates fallow stopped reporting and reopens them when they return", async () => {
    const { store } = await setup();
    expect(await syncRecords(store, makeOutput([]), false)).toMatchObject({ resolved: 1 });
    expect(await syncRecords(store, makeOutput([makeFinding()]), false)).toMatchObject({
      reopened: 1,
    });
  });

  it("does not resolve anything from a scoped scan", async () => {
    const { store } = await setup();
    expect(await syncRecords(store, makeOutput([]), true)).toMatchObject({ resolved: 0 });
  });
});

describe("toVerdictsFile", () => {
  it("emits the fallow verdict contract, limited to current candidates", async () => {
    const { loaded, store } = await setup([
      makeFinding(),
      makeFinding({ finding_id: "security:other" }),
    ]);
    await judge(
      loaded,
      store,
      mockEngine(() => VULNERABLE),
      judgeOptions,
    );
    const { records } = await store.readRecords();

    const file = toVerdictsFile(records, new Set(["security:other"]));
    expect(file.schema_version).toBe("fallow-security-verdicts/v1");
    expect(file.verdicts).toHaveLength(1);
    expect(file.verdicts[0]).toMatchObject({
      schema_version: "fallow-security-verdict/v1",
      finding_id: "security:other",
      verdict: "survivor",
      confidence: "0.94",
      fix_direction: "avoid-shell",
    });
  });
});

describe("evaluate", () => {
  it("reports a dismissed vulnerability as the failure it is", async () => {
    const findings = [
      makeFinding({ finding_id: "security:vuln", severity: "medium" }),
      makeFinding({ finding_id: "security:safe", severity: "medium" }),
    ];
    const { loaded, store } = await setup(findings);
    await judge(
      loaded,
      store,
      mockEngine(() => SAFE_MITIGATED),
      judgeOptions,
    );

    const result = evaluate((await store.readRecords()).records, {
      schema_version: LABELS_SCHEMA,
      labels: [
        { finding_id: "security:vuln", expected: "vulnerable" },
        { finding_id: "security:safe", expected: "safe" },
      ],
    });
    expect(result.dismissPrecision).toBe(0.5);
    expect(result.missedVulnerabilities).toEqual(["security:vuln"]);
    expect(result.noiseRemoved).toBe(1);
  });
});

describe("judge failure handling", () => {
  it("keeps a valid verdict when a forced re-judge fails", async () => {
    const { loaded, store } = await setup();
    await judge(
      loaded,
      store,
      mockEngine(() => VULNERABLE),
      judgeOptions,
    );

    const rejected = {
      id: "rejected",
      evaluate: () => Promise.resolve(err(verdictError("engine_auth_failed", "bad key"))),
    };
    const result = await judge(loaded, store, rejected, { ...judgeOptions, rejudge: true });

    expect(result).toMatchObject({
      ok: true,
      data: { outcome: "error", fatal: { code: "engine_auth_failed" } },
    });
    const [record] = (await store.readRecords()).records;
    expect(record).toMatchObject({ status: "judged", decision: { verdict: "survivor" } });
  });
});

describe("policy changes", () => {
  it("applies new thresholds to stored answers without asking the engine again", async () => {
    const { root, store } = await setup([makeFinding({ severity: "medium" })]);
    const engine = mockEngine(() => ({ ...SAFE_MITIGATED, exploitable: 0.08 }));
    await judge(makeLoaded(root), store, engine, judgeOptions);

    const stricter = makeLoaded(root, { policy: { dismissMaxExploitable: { medium: 0.05 } } });
    await judge(stricter, store, engine, judgeOptions);

    const [record] = (await store.readRecords()).records;
    expect(engine.calls).toBe(1);
    expect(record?.decision?.verdict).toBe("needs-human-review");
    expect(record?.history.map((entry) => entry.verdict)).toEqual([
      "dismissed",
      "needs-human-review",
    ]);
  });
});
