import { describe, expect, it } from "vitest";

import type { DecisionEngine } from "../src/engine/types.ts";
import { evaluate, LABELS_SCHEMA } from "../src/eval/metrics.ts";
import { judge, refreshVerdicts } from "../src/pipeline/judge.ts";
import { syncRecords } from "../src/pipeline/scan.ts";
import { openStore } from "../src/state/store.ts";
import { verdictError } from "../src/util/errors.ts";
import { err, ok } from "../src/util/result.ts";
import { tokensToUsd } from "../src/util/tokens.ts";
import {
  answersFor,
  makeFinding,
  makeLoaded,
  makeOutput,
  makeProject,
  mockEngine,
  SAFE_MITIGATED,
  VULNERABLE,
  type Probabilities,
} from "./helpers.ts";

const judgeOptions = { rejudge: false, dryRun: false };
const MEDIUM_BORDERLINE: Probabilities = { ...SAFE_MITIGATED, exploitable: 0.08 };

const setup = async (
  overrides: Record<string, unknown> = {},
  findings = [makeFinding({ severity: "medium" })],
) => {
  const root = await makeProject();
  const loaded = makeLoaded(root, { engine: { concurrency: 1 }, ...overrides });
  const store = openStore(loaded.dataDir, "security");
  const output = makeOutput(findings);
  await store.writeJson(store.candidatesPath, output);
  await syncRecords(store, output, false);
  return { root, loaded, store };
};

/** Answers the calls in order, then repeats the last answer set. */
const sequence = (...answers: Probabilities[]): DecisionEngine & { calls: number } => {
  let call = 0;
  return mockEngine(() => answers[Math.min(call++, answers.length - 1)] ?? VULNERABLE);
};

const onlyRecord = async (store: ReturnType<typeof openStore>) => {
  const [record] = (await store.readRecords()).records;
  if (record === undefined) throw new Error("no record");
  return record;
};

describe("dismissal agreement", () => {
  it("keeps a dismissal when a second call agrees, and stores both answer sets", async () => {
    const { loaded, store } = await setup();
    const engine = sequence(SAFE_MITIGATED, SAFE_MITIGATED);

    const result = await judge(loaded, store, engine, judgeOptions);

    const record = await onlyRecord(store);
    expect(engine.calls).toBe(2);
    expect(record.decision).toMatchObject({ verdict: "dismissed", rule: "dismissed" });
    expect(record.answers).toEqual(answersFor(SAFE_MITIGATED));
    expect(record.confirmationAnswers).toEqual(answersFor(SAFE_MITIGATED));
    expect(record.history.map((entry) => entry.rule)).toEqual(["dismissed"]);
    expect(result).toMatchObject({ ok: true, data: { judged: 1, inputTokens: 2000 } });
  });

  it("sends a disagreeing dismissal to a person with a named rule", async () => {
    const { loaded, store } = await setup();
    const engine = sequence(SAFE_MITIGATED, VULNERABLE);

    await judge(loaded, store, engine, judgeOptions);

    const record = await onlyRecord(store);
    expect(engine.calls).toBe(2);
    expect(record.decision).toMatchObject({
      verdict: "needs-human-review",
      rule: "dismissal-unconfirmed",
      dismissalReason: null,
    });
    expect(record.answers).toEqual(answersFor(SAFE_MITIGATED));
    expect(record.confirmationAnswers).toEqual(answersFor(VULNERABLE));
  });

  it("sends the same request twice", async () => {
    const { loaded, store } = await setup();
    const requests: unknown[] = [];
    const engine: DecisionEngine = {
      id: "recording",
      evaluate: (request) => {
        requests.push({ state: request.state, questions: request.questions });
        return Promise.resolve(
          ok({
            model: "mock-1",
            answers: answersFor(SAFE_MITIGATED),
            inputTokens: 10,
            latencyMs: 1,
          }),
        );
      },
    };

    await judge(loaded, store, engine, judgeOptions);

    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
  });

  it("does not ask twice for a survivor or a review", async () => {
    const { loaded, store } = await setup();
    const engine = mockEngine(() => VULNERABLE);

    await judge(loaded, store, engine, judgeOptions);

    const record = await onlyRecord(store);
    expect(engine.calls).toBe(1);
    expect(record.decision?.verdict).toBe("survivor");
    expect(record).not.toHaveProperty("confirmationAnswers");
  });

  it("keeps the single-call behavior when confirmDismissals is false", async () => {
    const { loaded, store } = await setup({ policy: { confirmDismissals: false } });
    const engine = sequence(SAFE_MITIGATED, VULNERABLE);

    await judge(loaded, store, engine, judgeOptions);

    const record = await onlyRecord(store);
    expect(engine.calls).toBe(1);
    expect(record.decision?.verdict).toBe("dismissed");
    expect(record).not.toHaveProperty("confirmationAnswers");
  });

  it("sends a dismissal to a person when the confirmation call fails", async () => {
    const { loaded, store } = await setup();
    let calls = 0;
    const engine: DecisionEngine = {
      id: "flaky",
      evaluate: () => {
        calls += 1;
        return Promise.resolve(
          calls === 1
            ? ok({
                model: "m",
                answers: answersFor(SAFE_MITIGATED),
                inputTokens: 1000,
                latencyMs: 1,
              })
            : err(verdictError("engine_unavailable", "down")),
        );
      },
    };

    const result = await judge(loaded, store, engine, judgeOptions);

    const record = await onlyRecord(store);
    expect(record).toMatchObject({
      status: "judged",
      decision: { verdict: "needs-human-review", rule: "dismissal-unconfirmed" },
      usage: { inputTokens: 1000 },
    });
    expect(result).toMatchObject({ ok: true, data: { judged: 1, errors: 0, inputTokens: 1000 } });
  });
});

describe("dismissal agreement remap", () => {
  it("does not remap a stored single answer set to dismissed", async () => {
    const { root, store } = await setup();
    const engine = mockEngine(() => SAFE_MITIGATED);
    await judge(
      makeLoaded(root, { policy: { confirmDismissals: false } }),
      store,
      engine,
      judgeOptions,
    );

    await refreshVerdicts(makeLoaded(root), store);

    const record = await onlyRecord(store);
    expect(engine.calls).toBe(1);
    expect(record.decision).toMatchObject({
      verdict: "needs-human-review",
      rule: "dismissal-unconfirmed",
    });
    expect(record.history.map((entry) => entry.rule)).toEqual([
      "dismissed",
      "dismissal-unconfirmed",
    ]);
  });

  it("reads an old record without a confirmation field", async () => {
    const { root, store } = await setup();
    await judge(
      makeLoaded(root, { policy: { confirmDismissals: false } }),
      store,
      mockEngine(() => SAFE_MITIGATED),
      judgeOptions,
    );
    const stored = await onlyRecord(store);
    expect(stored).not.toHaveProperty("confirmationAnswers");
    expect(stored.decision?.verdict).toBe("dismissed");

    await refreshVerdicts(makeLoaded(root), store);
    expect((await onlyRecord(store)).decision?.rule).toBe("dismissal-unconfirmed");
  });

  it("does not remap a looser policy to dismissed without a confirming answer set", async () => {
    const { root, store } = await setup();
    const engine = mockEngine(() => MEDIUM_BORDERLINE);
    await judge(
      makeLoaded(root, { policy: { dismissMaxExploitable: { medium: 0.05 } } }),
      store,
      engine,
      judgeOptions,
    );
    expect((await onlyRecord(store)).decision?.rule).toBe("uncertain");

    await refreshVerdicts(makeLoaded(root), store);

    expect(engine.calls).toBe(1);
    expect((await onlyRecord(store)).decision?.rule).toBe("dismissal-unconfirmed");
  });

  it("remaps both stored answer sets under a new policy", async () => {
    const { root, store } = await setup();
    const engine = sequence(MEDIUM_BORDERLINE, SAFE_MITIGATED);
    await judge(makeLoaded(root), store, engine, judgeOptions);
    expect((await onlyRecord(store)).decision?.verdict).toBe("dismissed");

    const stricter = makeLoaded(root, { policy: { dismissMaxExploitable: { medium: 0.05 } } });
    await refreshVerdicts(stricter, store);
    expect((await onlyRecord(store)).decision?.rule).toBe("uncertain");

    await refreshVerdicts(makeLoaded(root), store);
    expect(engine.calls).toBe(2);
    expect((await onlyRecord(store)).decision?.verdict).toBe("dismissed");
  });
});

describe("dismissal agreement cost", () => {
  it("counts both calls in the record usage and the run cost", async () => {
    const { loaded, store } = await setup();

    const result = await judge(
      loaded,
      store,
      mockEngine(() => SAFE_MITIGATED),
      judgeOptions,
    );

    const record = await onlyRecord(store);
    expect(record.usage).toEqual({ inputTokens: 2000, costUsd: tokensToUsd(2000), latencyMs: 2 });
    expect(result.ok && result.data.costUsd).toBe(tokensToUsd(2000));
  });

  it("states an upper bound for confirmation calls on a dry run", async () => {
    const on = await setup();
    const off = await setup({ policy: { confirmDismissals: false } });
    const engine = mockEngine(() => SAFE_MITIGATED);

    const withConfirmation = await judge(on.loaded, on.store, engine, {
      ...judgeOptions,
      dryRun: true,
    });
    const without = await judge(off.loaded, off.store, engine, { ...judgeOptions, dryRun: true });

    expect(engine.calls).toBe(0);
    if (!withConfirmation.ok || !without.ok) throw new Error("dry run failed");
    expect(withConfirmation.data.estimatedUsd).toBe(without.data.estimatedUsd);
    expect(withConfirmation.data.maxConfirmationUsd).toBe(withConfirmation.data.estimatedUsd);
    expect(without.data.maxConfirmationUsd).toBe(0);
  });

  it("does not pass the cost cap for a confirmation call", async () => {
    const { loaded, store } = await setup();
    const plan = await judge(
      loaded,
      store,
      mockEngine(() => SAFE_MITIGATED),
      {
        ...judgeOptions,
        dryRun: true,
      },
    );
    const single = plan.ok ? plan.data.estimatedUsd : 0;
    const engine = mockEngine(() => SAFE_MITIGATED);

    await judge(loaded, store, engine, { ...judgeOptions, maxCostUsd: single * 1.5 });

    expect(engine.calls).toBe(1);
    expect((await onlyRecord(store)).decision?.rule).toBe("dismissal-unconfirmed");
  });
});

describe("dismissal agreement evaluation", () => {
  it("reports the dismissals that the confirmation changed", async () => {
    const findings = [
      makeFinding({ finding_id: "security:vuln", severity: "medium" }),
      makeFinding({ finding_id: "security:safe", severity: "medium" }),
    ];
    const { loaded, store } = await setup({}, findings);
    // Both first answers dismiss; the second call does not confirm the vulnerable one.
    const seen = new Set<string>();
    const engine = mockEngine((state) => {
      const id = (state as { finding_id: string }).finding_id;
      const repeat = seen.has(id);
      seen.add(id);
      return id === "security:vuln" && repeat ? VULNERABLE : SAFE_MITIGATED;
    });
    await judge(loaded, store, engine, judgeOptions);

    const result = evaluate((await store.readRecords()).records, {
      schema_version: LABELS_SCHEMA,
      labels: [
        { finding_id: "security:vuln", expected: "vulnerable" },
        { finding_id: "security:safe", expected: "safe" },
      ],
    });
    expect(result.missedVulnerabilities).toEqual([]);
    expect(result.dismissalsUnconfirmed).toEqual({ total: 1, vulnerable: 1, safe: 0 });
  });
});
