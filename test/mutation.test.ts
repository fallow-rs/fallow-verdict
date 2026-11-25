import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseCli, type CliOptions } from "../src/cli/args.ts";
import { dispatchKind } from "../src/cli/main.ts";
import type { Answer, DecisionEngine } from "../src/engine/types.ts";
import { mutationAdapter } from "../src/kinds/mutation.ts";
import type { MutantPacket } from "../src/packet/mutation.ts";
import { checkWith } from "../src/pipeline/check.ts";
import { judgeWith } from "../src/pipeline/judge.ts";
import { scanWith } from "../src/pipeline/scan.ts";
import { openStore } from "../src/state/store.ts";
import { ok } from "../src/util/result.ts";
import { readFixture, stubProject, type StubProject } from "./mutation-helpers.ts";

const KIND = "mutation";
const EQUIVALENT_ID = "0cb13f9350cad239";
const GAP_ID = "d8d14c2ade9279b6";
const WITNESS_ID = "c9cdd0a284339dca";
const STALE_ID = "97d5de870c990ecb";

type Shape = { behavior: number; equivalence: string; strength: number; tampering?: number };

const REAL: Shape = { behavior: 0.92, equivalence: "not-equivalent", strength: 0.9 };
const UNSURE: Shape = { behavior: 0.4, equivalence: "other", strength: 0.5 };

const answersFor = (shape: Shape): Record<string, Answer> => ({
  behavior_changes: { type: "noul", probability: shape.behavior },
  equivalence: {
    type: "choice",
    choice: shape.equivalence,
    probabilities: { [shape.equivalence]: shape.strength },
    confidence: shape.strength,
  },
  test_direction: {
    type: "choice",
    choice: "boundary-value",
    probabilities: { "boundary-value": 0.8 },
    confidence: 0.8,
  },
  tampering: { type: "noul", probability: shape.tampering ?? 0.01 },
});

/** A fake engine: the answers depend on the mutant id in the packet, and each call is logged. */
const fakeEngine = (
  shapes: Readonly<Record<string, Shape | readonly Shape[]>>,
): DecisionEngine & { calls: string[] } => {
  const engine = {
    id: "fake",
    calls: [] as string[],
    evaluate: (request: { state: unknown }) => {
      const id = (request.state as MutantPacket).mutant.mutant_id;
      const index = engine.calls.filter((call) => call === id).length;
      engine.calls.push(id);
      const entry = shapes[id] ?? UNSURE;
      const shape = Array.isArray(entry) ? (entry[index] ?? UNSURE) : (entry as Shape);
      return Promise.resolve(
        ok({ model: "fake-1", answers: answersFor(shape), inputTokens: 1000, latencyMs: 1 }),
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

const JUDGE = { rejudge: false, dryRun: false } as const;

const setup = async (config: Record<string, unknown> = {}) => {
  const project = await stubProject(config);
  await project.setInspect(STALE_ID, {
    ...((await readFixture("stale-0cb13f9350cad239.json")) as Record<string, unknown>),
    mutant_id: STALE_ID,
  });
  const store = openStore(project.loaded.dataDir, KIND);
  const scanned = await scanWith(mutationAdapter, project.loaded, store, {});
  expect(scanned).toMatchObject({ ok: true, data: { candidates: 13 } });
  return { project, store };
};

const report = async (project: StubProject) => {
  const result = await dispatchKind(mutationAdapter, {
    options: optionsFor(["report", "--quiet", "--kind", KIND, "--show-dismissed"]),
    loaded: project.loaded,
    store: openStore(project.loaded.dataDir, KIND),
    signal: new AbortController().signal,
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
};

const PROPOSALS = (project: StubProject): string =>
  path.join(project.loaded.dataDir, "mutation-verdicts.proposed.json");

const planFor = async (replay: boolean) => {
  const { project, store } = await setup({ mutation: { replay } });
  const engine = fakeEngine({});
  const result = await judgeWith(mutationAdapter, project.loaded, store, engine, {
    ...JUDGE,
    dryRun: true,
  });
  expect(engine.calls).toEqual([]);
  if (!result.ok) throw new Error(result.error.message);
  return result.data.estimatedUsd;
};

describe("mutation kind", () => {
  it("judges survivors, confirms each proposal with a second call, and writes only the proposal file", async () => {
    const { project, store } = await setup({ mutation: { replay: true } });
    const engine = fakeEngine({
      [EQUIVALENT_ID]: { behavior: 0.01, equivalence: "value-never-occurs", strength: 0.96 },
      [GAP_ID]: REAL,
      "0ab0249adef9e6e3": { behavior: 0.81, equivalence: "not-equivalent", strength: 0.9 },
      a60af096b11f6968: { ...REAL, tampering: 0.7 },
    });
    const judged = await judgeWith(mutationAdapter, project.loaded, store, engine, JUDGE);
    expect(judged).toMatchObject({ ok: true, data: { errors: 0, pending: 0 } });

    // A stale packet and a replay witness need no engine call; a proposal needs two.
    expect(engine.calls).not.toContain(STALE_ID);
    expect(engine.calls).not.toContain(WITNESS_ID);
    expect(engine.calls.filter((id) => id === EQUIVALENT_ID)).toHaveLength(2);
    expect(engine.calls.filter((id) => id === GAP_ID)).toHaveLength(1);

    const { records } = await store.readRecords();
    const rule = (id: string) => records.find((record) => record.finding_id === id)?.decision?.rule;
    expect(rule(STALE_ID)).toBe("evidence-stale");
    expect(rule(WITNESS_ID)).toBe("replay-witness");
    expect(rule("a60af096b11f6968")).toBe("tampering-suspected");
    expect(rule(GAP_ID)).toBe("real-gap");
    expect(rule(EQUIVALENT_ID)).toBe("likely-equivalent");
    expect(records.find((record) => record.finding_id === WITNESS_ID)?.usage?.costUsd).toBe(0);

    const human = (await report(project)).human ?? "";
    // Survivors come first, highest probability first, with the test direction and replay input.
    const order = [
      "Test gaps",
      WITNESS_ID,
      GAP_ID,
      "0ab0249adef9e6e3",
      "Needs review",
      "Proposed as equivalent",
      EQUIVALENT_ID,
    ];
    const positions = order.map((text) => human.indexOf(text));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual(positions.toSorted((a, b) => a - b));
    expect(human).toContain("Replay input: [[1,2,3],0,2]");
    expect(human).toContain("Test direction: boundary-value");

    const proposals = JSON.parse(await readFile(PROPOSALS(project), "utf8")) as unknown;
    expect(proposals).toEqual({
      schema_version: "1",
      verdicts: [
        {
          review_key: EQUIVALENT_ID,
          verdict: "equivalent",
          note: expect.stringMatching(
            /^Proposed by fallow-verdict, not reviewed: equivalence value-never-occurs \(0\.96\), P\(behavior_changes\) 0\.01, decision likely-equivalent in run \S+\.$/,
          ) as unknown,
        },
      ],
    });
    // Fallow never receives the proposals, and the state holds no other verdict document.
    expect((await project.calls()).some((args) => args.includes("--verdicts"))).toBe(false);
    expect(await readdir(store.dataDir)).not.toContain("verdicts.json");
  });

  it("does not propose a dismissal that the second call does not confirm", async () => {
    const { project, store } = await setup();
    const engine = fakeEngine({
      [EQUIVALENT_ID]: [
        { behavior: 0.01, equivalence: "same-value", strength: 0.97 },
        { behavior: 0.3, equivalence: "same-value", strength: 0.97 },
      ],
    });
    await judgeWith(mutationAdapter, project.loaded, store, engine, JUDGE);
    const { records } = await store.readRecords();
    const record = records.find((entry) => entry.finding_id === EQUIVALENT_ID);
    expect(record?.decision?.rule).toBe("dismissal-unconfirmed");
    expect(record?.decision?.verdict).toBe("needs-human-review");
    await report(project);
    expect(JSON.parse(await readFile(PROPOSALS(project), "utf8"))).toEqual({
      schema_version: "1",
      verdicts: [],
    });
  });

  it("confirms proposals also when the global policy turns confirmation off", async () => {
    const { project, store } = await setup({ policy: { confirmDismissals: false } });
    const engine = fakeEngine({
      [EQUIVALENT_ID]: { behavior: 0.01, equivalence: "same-value", strength: 0.97 },
    });
    await judgeWith(mutationAdapter, project.loaded, store, engine, JUDGE);
    expect(engine.calls.filter((id) => id === EQUIVALENT_ID)).toHaveLength(2);
  });

  it("estimates no cost for a decision that needs no engine call", async () => {
    // The stale mutant never costs a call. With replay on, the witness mutant costs none either.
    const withoutReplay = await planFor(false);
    const withReplay = await planFor(true);
    expect(withReplay).toBeGreaterThan(0);
    expect(withReplay).toBeLessThan(withoutReplay);
  });

  it("resolves a stored mutant on a new scan only after a run of every file", async () => {
    const { project, store } = await setup();
    const tasks = (await readFixture("tasks.json")) as { tasks: { mutant_id: string }[] };
    const saved = (await readFixture("last-report.json")) as Record<string, unknown>;
    await project.setTasks({
      ...tasks,
      tasks: tasks.tasks.filter((task) => task.mutant_id !== GAP_ID),
    });
    await project.setReport({ ...saved, scope: { kind: "paths" } });
    const scoped = await scanWith(mutationAdapter, project.loaded, store, {});
    expect(scoped).toMatchObject({ ok: true, data: { resolved: 0 } });
    await project.setReport(saved);
    const all = await scanWith(mutationAdapter, project.loaded, store, {});
    expect(all).toMatchObject({ ok: true, data: { resolved: 1 } });
  });

  it("lists the test gaps first in the JSON report", async () => {
    const { project, store } = await setup();
    const engine = fakeEngine({
      [EQUIVALENT_ID]: { behavior: 0.01, equivalence: "same-value", strength: 0.99 },
      [GAP_ID]: { behavior: 0.75, equivalence: "not-equivalent", strength: 0.9 },
    });
    await judgeWith(mutationAdapter, project.loaded, store, engine, JUDGE);
    const json = (await report(project)).json as {
      findings: { finding_id: string; decision: { verdict: string } }[];
    };
    const verdicts = json.findings.map((finding) => finding.decision.verdict);
    expect(verdicts[0]).toBe("survivor");
    expect(verdicts.indexOf("dismissed")).toBeGreaterThan(verdicts.lastIndexOf("survivor"));
    expect(verdicts.indexOf("dismissed")).toBeGreaterThan(
      verdicts.lastIndexOf("needs-human-review"),
    );
  });

  it("refuses --changed-since, because the scope belongs to the fallow mutation run", async () => {
    const project = await stubProject();
    const store = openStore(project.loaded.dataDir, KIND);
    const scanned = await scanWith(mutationAdapter, project.loaded, store, {
      changedSince: "main",
    });
    expect(scanned).toMatchObject({ ok: false, error: { code: "config_invalid" } });
  });
});

const checkOf = (project: StubProject, target: string) =>
  checkWith(mutationAdapter, project.loaded, openStore(project.loaded.dataDir, KIND), {
    target,
    cwd: project.root,
    dryRun: false,
    engine: () => ok(fakeEngine({ [GAP_ID]: REAL })),
  });

describe("mutation check", () => {
  it("resolves a mutant that a recheck killed, and not on a partial report", async () => {
    const { project } = await setup();
    const tasks = (await readFixture("tasks.json")) as { tasks: { mutant_id: string }[] };
    const killed = { ...tasks, tasks: tasks.tasks.filter((task) => task.mutant_id !== GAP_ID) };

    const before = await checkOf(project, GAP_ID);
    expect(before.ok && before.data.report.results[0]).toMatchObject({
      status: "judged",
      verdict: "survivor",
    });

    await project.setTasks({ ...killed, report_completion: "partial" });
    const partial = await checkOf(project, GAP_ID);
    expect(partial.ok && partial.data.report.results[0]?.status).toBe("ambiguous");

    await project.setTasks(killed);
    const after = await checkOf(project, GAP_ID);
    expect(after.ok && after.data.report).toMatchObject({
      outcome: "cleared",
      results: [{ status: "resolved", stored_id: GAP_ID }],
    });
  });

  it("resolves only in a file that the saved run mutated", async () => {
    const { project } = await setup();
    const tasks = (await readFixture("tasks.json")) as { tasks: { mutant_id: string }[] };
    await project.setTasks({
      ...tasks,
      tasks: tasks.tasks.filter((task) => task.mutant_id !== GAP_ID),
    });
    const saved = (await readFixture("last-report.json")) as {
      files: { path: string }[];
    };
    const without = saved.files.filter((file) => file.path !== "src/list.ts");
    await project.setReport({ ...saved, scope: { kind: "paths" }, files: without });
    const outside = await checkOf(project, GAP_ID);
    expect(outside.ok && outside.data.report.results[0]?.status).toBe("ambiguous");

    await project.setReport(null);
    const missing = await checkOf(project, GAP_ID);
    expect(missing.ok && missing.data.report.results[0]?.status).toBe("ambiguous");

    await project.setReport(saved);
    const inside = await checkOf(project, GAP_ID);
    expect(inside.ok && inside.data.report.results[0]?.status).toBe("resolved");
  });

  it("gives a stale mutant to a person without an engine call", async () => {
    const { project } = await setup();
    const result = await checkWith(
      mutationAdapter,
      project.loaded,
      openStore(project.loaded.dataDir, KIND),
      {
        target: STALE_ID,
        cwd: project.root,
        dryRun: false,
        engine: () => {
          throw new Error("no engine is needed");
        },
      },
    );
    expect(result.ok && result.data.report).toMatchObject({
      outcome: "needs-person",
      results: [{ status: "judged", rule: "evidence-stale" }],
      usage: { input_tokens: 0 },
    });
  });
});
