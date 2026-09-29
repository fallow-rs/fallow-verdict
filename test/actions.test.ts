import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { parseCli, type CliOptions } from "../src/cli/args.ts";
import { dispatchKind } from "../src/cli/main.ts";
import type { LoadedConfig } from "../src/config/load.ts";
import { securityAdapter } from "../src/kinds/security.ts";
import { judge } from "../src/pipeline/judge.ts";
import { closeWith } from "../src/pipeline/close.ts";
import { syncRecords } from "../src/pipeline/scan.ts";
import { judgeOutputSchema, reportActions, reportOutputSchema } from "../src/report/actions.ts";
import { buildReport } from "../src/report/render.ts";
import { securityPriority } from "../src/report/security.ts";
import { openStore, type Store } from "../src/state/store.ts";
import { ok } from "../src/util/result.ts";
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

const repo = fileURLToPath(new URL("../", import.meta.url));
const cli = path.join(repo, "bin/fallow-verdict.js");

const optionsFor = (argv: string[]): CliOptions => {
  const parsed = parseCli(argv, {});
  if (!parsed.ok || parsed.data.kind !== "command") throw new Error("Invalid test arguments");
  return parsed.data.options;
};

const ID = {
  survivor: "security:tainted-sink:src/routes/user.ts:5",
  closed: "security:tainted-sink:src/routes/user.ts:5:40",
  dismissed: "security:tainted-sink:src/routes/user.ts:4",
  review: "security:tainted-sink:src/routes/user.ts:6",
  pending: "security:tainted-sink:src/routes/admin.ts:5",
} as const;

const ADMIN_FILE = "src/routes/admin.ts";

/** A finding in another file, so that its scan does not change the evidence of the others. */
const pendingFinding = (): ReturnType<typeof makeFinding> =>
  makeFinding({
    finding_id: ID.pending,
    path: ADMIN_FILE,
    trace: [
      { path: ADMIN_FILE, line: 4, col: 13, role: "untrusted-source" },
      { path: ADMIN_FILE, line: 5, col: 21, role: "sink" },
    ],
    candidate: {
      ...makeFinding().candidate,
      sink: { ...makeFinding().candidate.sink, path: ADMIN_FILE },
    },
  });

/** One finding for each state: survivor, closed, dismissed, needs review, and pending. */
const mixedState = async (): Promise<{ loaded: LoadedConfig; store: Store }> => {
  const root = await makeProject({ [SINK_FILE]: SINK_SOURCE, [ADMIN_FILE]: SINK_SOURCE });
  const loaded = makeLoaded(root, { engine: { concurrency: 1 } });
  const store = openStore(loaded.dataDir, "security");
  const judged = [
    makeFinding({ finding_id: ID.survivor }),
    makeFinding({ finding_id: ID.closed, col: 40 }),
    makeFinding({ finding_id: ID.dismissed, line: 4, col: 13 }),
    makeFinding({ finding_id: ID.review, line: 6, col: 3, category: "ssrf" }),
  ];
  const first = makeOutput(judged);
  await store.writeJson(store.candidatesPath, first);
  await syncRecords(store, first, false);
  const responses = new Map<string, typeof VULNERABLE>([
    [ID.survivor, VULNERABLE],
    [ID.closed, VULNERABLE],
    [ID.dismissed, SAFE_MITIGATED],
    [ID.review, { ...VULNERABLE, tampering: 0.9 }],
  ]);
  const engine = mockEngine(
    (state) => responses.get((state as { finding_id: string }).finding_id) ?? VULNERABLE,
  );
  await judge(loaded, store, engine, { rejudge: false, dryRun: false });
  // Fallow still reports the finding as in the last scan, so close accepts it.
  const unchanged = {
    ...securityAdapter,
    scan: { ...securityAdapter.scan, run: () => Promise.resolve(ok(first)) },
  };
  const closed = await closeWith(unchanged, loaded, store, ID.closed, "Accepted risk.");
  expect(closed).toMatchObject({ ok: true });
  const all = makeOutput([...judged, pendingFinding()]);
  await store.writeJson(store.candidatesPath, all);
  await syncRecords(store, all, false, loaded);
  return { loaded, store };
};

describe("actions in the report output", () => {
  it("list judge, check and close steps, and nothing for dismissed or closed findings", async () => {
    const { loaded, store } = await mixedState();
    const outcome = await dispatchKind(securityAdapter, {
      options: optionsFor(["report", "--quiet", "--no-validate", "--fail-on", "off"]),
      loaded,
      store,
      signal: new AbortController().signal,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const report = reportOutputSchema.parse(outcome.data.json);
    expect(report.summary).toMatchObject({ survivors: 1, needsHumanReview: 1, pending: 1 });
    expect(
      report.actions.map(({ type, command, finding_id }) => ({ type, command, finding_id })),
    ).toEqual([
      { type: "judge", command: "npx fallow-verdict judge", finding_id: undefined },
      {
        type: "check",
        command: `npx fallow-verdict check ${ID.survivor}`,
        finding_id: ID.survivor,
      },
      {
        type: "close",
        command: `npx fallow-verdict close ${ID.survivor} --reason "<reason>"`,
        finding_id: ID.survivor,
      },
      { type: "check", command: `npx fallow-verdict check ${ID.review}`, finding_id: ID.review },
      {
        type: "close",
        command: `npx fallow-verdict close ${ID.review} --reason "<reason>"`,
        finding_id: ID.review,
      },
    ]);
    for (const close of report.actions.filter((action) => action.type === "close"))
      expect(close.description).toContain("Only a person can close");
    for (const action of report.actions) expect(action.auto_fixable).toBe(false);
  });

  it("is the same list in the status output", async () => {
    const { loaded, store } = await mixedState();
    const status = await dispatchKind(securityAdapter, {
      options: optionsFor(["status", "--quiet"]),
      loaded,
      store,
      signal: new AbortController().signal,
    });
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    const report = reportOutputSchema.parse(status.data.json);
    expect(report.actions.map((action) => action.type)).toEqual([
      "judge",
      "check",
      "close",
      "check",
      "close",
    ]);
  });

  it("names the kind in each command for a kind that is not the default", async () => {
    const { store } = await mixedState();
    const report = buildReport((await store.readRecords()).records, securityPriority);
    const actions = reportActions(report, { invocation: "npx fallow-verdict", kind: "review" });
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) expect(action.command).toMatch(/ --kind review$/);
  });

  it("repeat --cwd and --question-profile of the command that made the report", async () => {
    const { loaded, store } = await mixedState();
    const report = buildReport((await store.readRecords()).records, securityPriority);
    const { actions: context } = optionsFor([
      "run",
      "--cwd",
      loaded.root,
      "--question-profile",
      "category",
    ]);
    const actions = reportActions(report, context);
    const check = actions.find((action) => action.type === "check");
    expect(check?.command).toBe(
      `npx fallow-verdict check ${ID.survivor} --question-profile category --cwd ${loaded.root}`,
    );
    // close takes no question profile, but it needs the same state directory.
    const close = actions.find((action) => action.type === "close");
    expect(close?.command).toBe(
      `npx fallow-verdict close ${ID.survivor} --reason "<reason>" --cwd ${loaded.root}`,
    );
    const judgeStep = actions.find((action) => action.type === "judge");
    expect(judgeStep?.command).toBe(
      `npx fallow-verdict judge --question-profile category --cwd ${loaded.root}`,
    );
  });

  it("is empty when every finding is dismissed or closed", async () => {
    const root = await makeProject();
    const loaded = makeLoaded(root);
    const store = openStore(loaded.dataDir, "security");
    const output = makeOutput([makeFinding()]);
    await store.writeJson(store.candidatesPath, output);
    await syncRecords(store, output, false);
    await judge(
      loaded,
      store,
      mockEngine(() => SAFE_MITIGATED),
      { rejudge: false, dryRun: false },
    );
    const outcome = await dispatchKind(securityAdapter, {
      options: optionsFor(["report", "--quiet", "--no-validate"]),
      loaded,
      store,
      signal: new AbortController().signal,
    });
    expect(outcome.ok && reportOutputSchema.parse(outcome.data.json).actions).toEqual([]);
  });
});

describe("actions in the judge output", () => {
  it("offer the same judge command without --dry-run after a dry run", async () => {
    const { loaded, store } = await mixedState();
    const outcome = await dispatchKind(securityAdapter, {
      options: optionsFor(["judge", "--dry-run", "--quiet", "--limit", "5"]),
      loaded,
      store,
      signal: new AbortController().signal,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const summary = judgeOutputSchema.parse(outcome.data.json);
    expect(summary.actions).toEqual([
      expect.objectContaining({
        type: "judge",
        command: "npx fallow-verdict judge --quiet --limit 5",
      }),
    ]);
  });
});

/** Runs the built CLI with no API key, so any Jev request fails. */
const runCli = (args: string[]): Promise<{ code: number; data: unknown }> =>
  new Promise((resolve, reject) => {
    // Without a package manager agent, the invocation is always `npx fallow-verdict`.
    const { TYPESAFE_API_KEY: _key, npm_config_user_agent: _agent, ...env } = process.env;
    execFile(process.execPath, [cli, ...args], { env }, (error, stdout) => {
      if (error !== null && typeof error.code !== "number") return reject(error);
      let data: unknown;
      try {
        data = JSON.parse(stdout) as unknown;
      } catch (cause) {
        return reject(cause);
      }
      resolve({ code: typeof error?.code === "number" ? error.code : 0, data });
    });
  });

it("run --dry-run offers the same run without --dry-run", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "verdict-actions-"));
  try {
    await cp(path.join(repo, "eval/corpus/src"), path.join(root, "src"), { recursive: true });
    await cp(path.join(repo, "eval/corpus/package.json"), path.join(root, "package.json"));
    await writeFile(
      path.join(root, "fallow-verdict.config.json"),
      JSON.stringify({ fallow: { binary: path.join(repo, "node_modules/.bin/fallow") } }),
    );
    const args = ["run", "--dry-run", "--cwd", root, "--format", "json", "--limit", "2", "src"];
    const result = await runCli(args);
    expect(result.code).toBe(0);
    const summary = judgeOutputSchema.parse(result.data);
    expect(summary.pending).toBeGreaterThan(0);
    expect(summary.actions).toEqual([
      expect.objectContaining({
        type: "run",
        auto_fixable: false,
        command: `npx fallow-verdict run --cwd ${root} --format json --limit 2 src`,
      }),
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it.each([
  ["report", reportOutputSchema],
  ["judge", judgeOutputSchema],
] as const)("keeps schemas/%s.schema.json current", async (name, schema) => {
  const file = fileURLToPath(new URL(`../schemas/${name}.schema.json`, import.meta.url));
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual(z.toJSONSchema(schema, { io: "input" }));
});
