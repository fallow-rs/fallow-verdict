import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { expect, it } from "vitest";

import { configSchema } from "../src/config/schema.ts";
import type { DecisionEngine, EvaluateResponse } from "../src/engine/types.ts";
import { compareQuestions, type ComparisonReport } from "../src/eval/comparison.ts";
import { buildPacket } from "../src/packet/build.ts";
import { QUESTIONS } from "../src/questions/catalog.ts";
import { openStore } from "../src/state/store.ts";
import { ok, type Result } from "../src/util/result.ts";
import { tokensToUsd } from "../src/util/tokens.ts";
import { answersFor, makeFinding, makeOutput, makeProject, SAFE_MITIGATED } from "./helpers.ts";

const MODEL = "jev-1.13.0";
const INPUT_TOKENS = 1000;
const setup = async (): Promise<
  { root: string } & Omit<Parameters<typeof compareQuestions>[0], "engine" | "onProgress">
> => {
  const root = await makeProject();
  const config = configSchema.parse({});
  const finding = makeFinding();
  const built = await buildPacket(finding, makeOutput([finding]), { root, ...config.packet });
  return {
    root,
    cases: [{ id: "case", expected: "safe" as const, mustReview: false, built }],
    variants: [
      { id: "baseline", questions: () => QUESTIONS },
      { id: "candidate", questions: () => QUESTIONS },
    ],
    model: MODEL,
    policy: config.policy,
    repeats: 2,
    maxCostUsd: 1,
    dryRun: false,
  };
};
const response = (): Result<EvaluateResponse, never> =>
  ok({
    model: MODEL,
    answers: answersFor(SAFE_MITIGATED),
    inputTokens: INPUT_TOKENS,
    latencyMs: 1,
  });

it("persists completed evidence before starting a request that unexpectedly rejects", async () => {
  const prepared = await setup();
  const file = path.join(prepared.root, "comparison.json");
  const store = openStore(prepared.root);
  let calls = 0;
  const engine: DecisionEngine = {
    id: "interrupted",
    evaluate: async () => {
      calls += 1;
      if (calls === 1) return response();
      throw new Error("connection interrupted");
    },
  };
  await expect(
    compareQuestions({
      ...prepared,
      engine,
      onProgress: (report: ComparisonReport) => store.writeJson(file, report),
    }),
  ).rejects.toThrow("connection interrupted");
  const saved: unknown = JSON.parse(await readFile(file, "utf8"));
  expect(saved).toMatchObject({
    complete: false,
    costUsd: tokensToUsd(INPUT_TOKENS),
    observations: [{ model: MODEL, answers: answersFor(SAFE_MITIGATED), variant: "baseline" }],
    summaries: [
      { complete: false, noiseRemoved: null, dismissPrecision: null },
      { complete: false, noiseRemoved: null, dismissPrecision: null },
    ],
  });
});

it.each([0, 1])(
  "stops paid requests when checkpoint storage fails after %i responses",
  async (limit) => {
    const prepared = await setup();
    let calls = 0;
    const engine: DecisionEngine = {
      id: "storage-failure",
      evaluate: async () => {
        calls += 1;
        return response();
      },
    };
    await expect(
      compareQuestions({
        ...prepared,
        engine,
        onProgress: async (report: ComparisonReport) => {
          if (report.observations.length === limit) throw new Error("storage unavailable");
        },
      }),
    ).rejects.toThrow("storage unavailable");
    expect(calls).toBe(limit);
  },
);

it.skipIf(process.platform === "win32")(
  "retains a readable private checkpoint when terminated during the next request",
  async () => {
    const prepared = await setup();
    const output = path.join(prepared.root, "comparison.json");
    const script = path.join(prepared.root, "interrupt.mjs");
    const moduleUrl = new URL("../src/eval/comparison.ts", import.meta.url).href;
    const storeUrl = new URL("../src/state/store.ts", import.meta.url).href;
    const serialized = JSON.stringify({ ...prepared, variants: undefined });
    await writeFile(
      script,
      `
import { compareQuestions } from ${JSON.stringify(moduleUrl)};
import { openStore } from ${JSON.stringify(storeUrl)};
const options = ${serialized};
const questions = ${JSON.stringify(QUESTIONS)};
const result = ${JSON.stringify(response())};
let calls = 0;
await compareQuestions({
  ...options,
  variants: [{ id: 'baseline', questions: () => questions }, { id: 'candidate', questions: () => questions }],
  engine: { id: 'interruption-test', evaluate: async () => {
    if (++calls === 1) return result;
    process.send('in-flight');
    return new Promise(() => {});
  } },
  onProgress: (report) => openStore(options.root).writeJson(${JSON.stringify(output)}, report),
});
`,
    );
    const child = spawn(process.execPath, [script], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    const exit = once(child, "exit");
    try {
      await Promise.race([
        once(child, "message"),
        exit.then(() => {
          throw new Error("Comparison exited before the in-flight request.");
        }),
      ]);
      child.kill("SIGTERM");
      await exit;
      const saved: unknown = JSON.parse(await readFile(output, "utf8"));
      expect(saved).toMatchObject({
        complete: false,
        costUsd: tokensToUsd(INPUT_TOKENS),
        observations: [{ model: MODEL, answers: answersFor(SAFE_MITIGATED) }],
      });
      expect((await stat(output)).mode & 0o777).toBe(0o600);
    } finally {
      child.kill();
    }
  },
);

it("persists final summaries and gives observers isolated snapshots", async () => {
  const prepared = await setup();
  const snapshots: ComparisonReport[] = [];
  const report = await compareQuestions({
    ...prepared,
    engine: { id: "successful", evaluate: async () => response() },
    onProgress: async (snapshot) => {
      snapshots.push(structuredClone(snapshot));
      snapshot.observations.length = 0;
      snapshot.policy.survivorMinExploitable = 0;
    },
  });
  expect(snapshots.at(-1)).toEqual(report);
  expect(snapshots[0]).toMatchObject({ complete: false, observations: [], costUsd: 0 });
  expect(report.complete).toBe(true);
  expect(report.observations.length).toBe(prepared.repeats * prepared.variants.length);
  expect(report.policy).toEqual(prepared.policy);
});
