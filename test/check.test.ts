import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { parseCli } from "../src/cli/args.ts";
import type { LoadedConfig } from "../src/config/load.ts";
import type { DecisionEngine } from "../src/engine/types.ts";
import type { SecurityFinding, SecurityOutput } from "../src/fallow/types.ts";
import type { AnalysisAdapter, ScanScope } from "../src/kinds/adapter.ts";
import { securityAdapter } from "../src/kinds/security.ts";
import type { BuiltPacket } from "../src/packet/build.ts";
import { checkWith, possibleMatches, relocate, type CheckOptions } from "../src/pipeline/check.ts";
import { closeWith, reopenChangedClosures } from "../src/pipeline/close.ts";
import { judge } from "../src/pipeline/judge.ts";
import { syncRecords } from "../src/pipeline/scan.ts";
import { checkReportSchema, renderCheckHuman } from "../src/report/check.ts";
import { buildReport, renderHuman, renderMarkdown } from "../src/report/render.ts";
import { securityPresentation, securityPriority } from "../src/report/security.ts";
import { toVerdictsFile } from "../src/verdicts/export.ts";
import { openStore, type Store } from "../src/state/store.ts";
import { verdictError } from "../src/util/errors.ts";
import { err, ok } from "../src/util/result.ts";
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
  type Probabilities,
} from "./helpers.ts";

type SecurityAdapter = AnalysisAdapter<SecurityOutput, SecurityFinding, BuiltPacket>;

const OLD_ID = "security:tainted-sink:src/routes/user.ts:5:21";
const MOVED_ID = "security:tainted-sink:src/routes/user.ts:6:21";

/** The security adapter with a fixed Fallow result, so a test controls the rerun. */
const withFreshScan = (findings: SecurityFinding[]): SecurityAdapter & { scans: number } => {
  const adapter = {
    ...securityAdapter,
    scans: 0,
    scan: {
      ...securityAdapter.scan,
      // Like the real scan: a scoped run reports only the findings in the given files.
      run: (_loaded: LoadedConfig, scope: ScanScope) => {
        adapter.scans += 1;
        const paths = scope.paths ?? [];
        return Promise.resolve(
          ok(
            makeOutput(
              paths.length === 0 ? findings : findings.filter((f) => paths.includes(f.path)),
            ),
          ),
        );
      },
    },
  };
  return adapter;
};

/** Fallow still reports the finding as in the last scan. */
const unchanged = (): SecurityAdapter => withFreshScan([makeFinding({ finding_id: OLD_ID })]);

/** The same finding one line lower, after a line was added above it. */
const movedFinding = (): SecurityFinding =>
  makeFinding({
    finding_id: MOVED_ID,
    line: 6,
    trace: [
      { path: SINK_FILE, line: 5, col: 13, role: "untrusted-source" },
      { path: SINK_FILE, line: 6, col: 21, role: "sink" },
    ],
    candidate: {
      ...makeFinding().candidate,
      sink: { ...makeFinding().candidate.sink, line: 6 },
    },
  });

const MOVED_SOURCE = `// Added line.\n${SINK_SOURCE}`;

type Scanned = { root: string; loaded: LoadedConfig; store: Store };

const scanned = async (findings: SecurityFinding[] = [makeFinding({ finding_id: OLD_ID })]) => {
  const root = await makeProject();
  const loaded = makeLoaded(root);
  const store = openStore(loaded.dataDir, "security");
  const output = makeOutput(findings);
  await store.writeJson(store.candidatesPath, output);
  await syncRecords(store, output, false);
  return { root, loaded, store } satisfies Scanned;
};

const engineFor = (
  probabilities: Probabilities,
): (() => ReturnType<CheckOptions["engine"]>) & {
  engine: ReturnType<typeof mockEngine>;
} => {
  const engine = mockEngine(() => probabilities);
  return Object.assign(() => ok<DecisionEngine>(engine), { engine });
};

const options = (
  state: Scanned,
  target: string,
  engine: CheckOptions["engine"],
  dryRun = false,
): CheckOptions => ({ target, cwd: state.root, dryRun, engine });

/** Every file in the state directory with its content, to prove that `check` writes nothing. */
const snapshot = async (dir: string): Promise<Record<string, string>> => {
  const files: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    files[path.relative(dir, file)] = await readFile(file, "utf8");
  }
  return files;
};

describe("relocate", () => {
  const stored = { id: "a:5", key: "k" };

  it("keeps a finding whose id did not change", () => {
    expect(relocate(stored, [stored], [{ id: "a:5", key: "k" }])).toEqual({
      type: "found",
      id: "a:5",
      moved: false,
    });
  });

  it("follows a moved finding by its key", () => {
    expect(relocate(stored, [stored], [{ id: "a:6", key: "k" }])).toEqual({
      type: "found",
      id: "a:6",
      moved: true,
    });
  });

  it("reports a removed finding as gone", () => {
    expect(relocate(stored, [stored], [{ id: "b:9", key: "other" }])).toEqual({ type: "gone" });
  });

  it("never concludes gone when two current findings match", () => {
    expect(
      relocate(
        stored,
        [stored],
        [
          { id: "a:6", key: "k" },
          { id: "a:9", key: "k" },
        ],
      ),
    ).toEqual({ type: "ambiguous", ids: ["a:6", "a:9"] });
  });

  it("does not pick one of two moved stored twins for a single match", () => {
    const twin = { id: "a:7", key: "k" };
    expect(relocate(twin, [stored, twin], [{ id: "a:6", key: "k" }])).toEqual({
      type: "ambiguous",
      ids: ["a:6"],
    });
  });

  it("ignores a stored twin that is unchanged at its own id", () => {
    const twin = { id: "a:7", key: "k" };
    expect(relocate(twin, [stored, twin], [{ id: "a:5", key: "k" }])).toEqual({ type: "gone" });
  });

  it("keeps a finding whose evidence text changed at the same location", () => {
    expect(relocate(stored, [stored], [{ id: "a:5", key: "changed" }])).toEqual({
      type: "found",
      id: "a:5",
      moved: false,
    });
  });

  it("does not take an id that another stored finding moved into", () => {
    const other = { id: "b:3", key: "other" };
    expect(relocate(stored, [stored, other], [{ id: "a:5", key: "other" }])).toEqual({
      type: "gone",
    });
  });
});

describe("check", () => {
  it("resolves a removed finding without a Jev call and exits 0", async () => {
    const state = await scanned();
    const engine = engineFor(VULNERABLE);
    const adapter = withFreshScan([]);
    const result = await checkWith(
      adapter,
      state.loaded,
      state.store,
      options(state, OLD_ID, engine),
    );
    expect(result.ok && result.data.report).toMatchObject({
      schema_version: "fallow-verdict-check/v1",
      kind: "security",
      target: { type: "finding", value: OLD_ID },
      outcome: "cleared",
      exit_code: 0,
      results: [{ status: "resolved", stored_id: OLD_ID, finding_id: null }],
    });
    // One Fallow run for the whole project.
    expect(adapter.scans).toBe(1);
    expect(engine.engine.calls).toBe(0);
  });

  it("exits 1 when the finding stands", async () => {
    const state = await scanned();
    const engine = engineFor(VULNERABLE);
    const result = await checkWith(
      withFreshScan([makeFinding({ finding_id: OLD_ID })]),
      state.loaded,
      state.store,
      options(state, OLD_ID, engine),
    );
    expect(result.ok && result.data.report).toMatchObject({
      outcome: "stands",
      exit_code: 1,
      results: [{ status: "judged", verdict: "survivor", finding_id: OLD_ID }],
    });
    expect(engine.engine.calls).toBe(1);
  });

  it("exits 0 when the finding is dismissed", async () => {
    const state = await scanned();
    const result = await checkWith(
      withFreshScan([makeFinding({ finding_id: OLD_ID })]),
      state.loaded,
      state.store,
      options(state, OLD_ID, engineFor(SAFE_MITIGATED)),
    );
    expect(result.ok && result.data.report).toMatchObject({
      outcome: "cleared",
      exit_code: 0,
      results: [{ status: "judged", verdict: "dismissed" }],
    });
  });

  it("exits 3 when the finding needs a person", async () => {
    const state = await scanned();
    const result = await checkWith(
      withFreshScan([makeFinding({ finding_id: OLD_ID })]),
      state.loaded,
      state.store,
      options(state, OLD_ID, engineFor({ ...VULNERABLE, tampering: 0.9 })),
    );
    expect(result.ok && result.data.report).toMatchObject({
      outcome: "needs-person",
      exit_code: 3,
      results: [{ status: "judged", verdict: "needs-human-review" }],
    });
  });

  it("exits 2 when Jev fails or no engine is available", async () => {
    const state = await scanned();
    const failing: DecisionEngine = {
      id: "failing",
      evaluate: () => Promise.resolve(err(verdictError("engine_unavailable", "down"))),
    };
    const adapter = withFreshScan([makeFinding({ finding_id: OLD_ID })]);
    const failed = await checkWith(
      adapter,
      state.loaded,
      state.store,
      options(state, OLD_ID, () => ok(failing)),
    );
    expect(failed.ok && failed.data.report).toMatchObject({
      outcome: "error",
      exit_code: 2,
      results: [{ status: "error", error: { code: "engine_unavailable" } }],
    });
    const noKey = await checkWith(
      adapter,
      state.loaded,
      state.store,
      options(state, OLD_ID, () => err(verdictError("engine_auth_failed", "no key"))),
    );
    expect(noKey.ok && noKey.data.report).toMatchObject({
      exit_code: 2,
      results: [{ status: "error", error: { code: "engine_auth_failed" } }],
    });
  });

  it("returns an error for an unknown target", async () => {
    const state = await scanned();
    const result = await checkWith(
      withFreshScan([]),
      state.loaded,
      state.store,
      options(state, "security:tainted-sink:nowhere.ts:1", engineFor(VULNERABLE)),
    );
    expect(result).toMatchObject({ ok: false, error: { code: "config_invalid" } });
  });

  it("writes no state", async () => {
    const state = await scanned();
    const before = await snapshot(state.loaded.dataDir);
    await checkWith(
      withFreshScan([makeFinding({ finding_id: OLD_ID })]),
      state.loaded,
      state.store,
      options(state, SINK_FILE, engineFor(VULNERABLE)),
    );
    expect(await snapshot(state.loaded.dataDir)).toEqual(before);
  });

  it("follows a finding that an edit above it moved, and judges it", async () => {
    const state = await scanned();
    await writeFile(path.join(state.root, SINK_FILE), MOVED_SOURCE);
    const engine = engineFor(VULNERABLE);
    const result = await checkWith(
      withFreshScan([movedFinding()]),
      state.loaded,
      state.store,
      options(state, OLD_ID, engine),
    );
    expect(result.ok && result.data.report).toMatchObject({
      exit_code: 1,
      results: [
        {
          status: "judged",
          stored_id: OLD_ID,
          finding_id: MOVED_ID,
          locations: [{ path: SINK_FILE, line: 6, col: 21 }],
        },
      ],
    });
    expect(engine.engine.calls).toBe(1);
  });

  it("resolves a removed finding while another finding in the file remains", async () => {
    const other = makeFinding({
      finding_id: "security:tainted-sink:src/routes/user.ts:4:13",
      line: 4,
      col: 13,
      evidence: "fetch receives a non-literal argument",
      category: "ssrf",
      candidate: {
        ...makeFinding().candidate,
        sink: { ...makeFinding().candidate.sink, line: 4, col: 13, callee: "fetch" },
      },
    });
    const state = await scanned([makeFinding({ finding_id: OLD_ID }), other]);
    const result = await checkWith(
      withFreshScan([other]),
      state.loaded,
      state.store,
      options(state, OLD_ID, engineFor(VULNERABLE)),
    );
    expect(result.ok && result.data.report).toMatchObject({
      exit_code: 0,
      results: [{ status: "resolved", stored_id: OLD_ID }],
    });
  });

  it("needs a person, not resolved, when the match is ambiguous", async () => {
    const state = await scanned();
    const twin = makeFinding({ ...movedFinding(), finding_id: MOVED_ID });
    const second = makeFinding({ ...movedFinding(), finding_id: `${MOVED_ID}0`, col: 210 });
    const engine = engineFor(VULNERABLE);
    const result = await checkWith(
      withFreshScan([twin, second]),
      state.loaded,
      state.store,
      options(state, OLD_ID, engine),
    );
    expect(result.ok && result.data.report).toMatchObject({
      outcome: "needs-person",
      exit_code: 3,
      results: [{ status: "ambiguous", stored_id: OLD_ID, matches: [MOVED_ID, `${MOVED_ID}0`] }],
    });
    expect(engine.engine.calls).toBe(0);
  });

  it("checks every current finding in a file target", async () => {
    const state = await scanned();
    const added = makeFinding({
      finding_id: "security:tainted-sink:src/routes/user.ts:6:3",
      line: 6,
      col: 3,
      evidence: "res.json receives a non-literal argument",
      candidate: {
        ...makeFinding().candidate,
        sink: { ...makeFinding().candidate.sink, line: 6, col: 3, callee: "res.json" },
      },
    });
    const engine = engineFor(SAFE_MITIGATED);
    const result = await checkWith(
      withFreshScan([makeFinding({ finding_id: OLD_ID }), added]),
      state.loaded,
      state.store,
      options(state, path.join(state.root, SINK_FILE), engine),
    );
    expect(result.ok && result.data.report).toMatchObject({
      target: { type: "path", value: SINK_FILE },
      exit_code: 0,
      results: [
        { status: "judged", stored_id: OLD_ID, finding_id: OLD_ID },
        { status: "judged", stored_id: null, finding_id: added.finding_id },
      ],
    });
    // Each dismissal needs a second call that agrees.
    expect(engine.engine.calls).toBe(4);
  });

  it("prints the estimate and sends nothing in a dry run", async () => {
    const state = await scanned();
    const engine = engineFor(VULNERABLE);
    const result = await checkWith(
      withFreshScan([makeFinding({ finding_id: OLD_ID })]),
      state.loaded,
      state.store,
      options(state, OLD_ID, engine, true),
    );
    expect(result.ok && result.data.report).toMatchObject({
      dry_run: true,
      outcome: "estimated",
      exit_code: 0,
      results: [{ status: "not-assessed" }],
    });
    expect(result.ok && result.data.report.estimate.input_tokens).toBeGreaterThan(0);
    expect(result.ok && result.data.report.estimate.max_confirmation_usd).toBe(
      result.ok ? result.data.report.estimate.usd : -1,
    );
    expect(engine.engine.calls).toBe(0);
    const human = result.ok ? renderCheckHuman(result.data, securityPresentation) : "";
    expect(human).toContain("Dry run: no requests were sent to Jev.");
    expect(human).toContain("Dismissal confirmation calls can add up to");
  });

  it("gives Fallow-style actions and matches the JSON schema", async () => {
    const state = await scanned();
    const result = await checkWith(
      withFreshScan([makeFinding({ finding_id: OLD_ID })]),
      state.loaded,
      state.store,
      options(state, OLD_ID, engineFor(VULNERABLE)),
    );
    if (!result.ok) throw new Error(result.error.message);
    expect(checkReportSchema.parse(result.data.report)).toEqual(result.data.report);
    expect(result.data.report.actions).toEqual([
      {
        type: "rerun-check",
        auto_fixable: false,
        description: expect.any(String),
        command: `fallow-verdict check ${OLD_ID}`,
      },
      {
        type: "close",
        auto_fixable: false,
        description: expect.any(String),
        command: `fallow-verdict close ${OLD_ID} --reason "<reason>"`,
        finding_id: OLD_ID,
      },
    ]);
    const human = renderCheckHuman(result.data, securityPresentation);
    expect(human).toContain("Likely vulnerability");
    expect(human).toContain(`fallow-verdict check ${OLD_ID}`);
  });

  it("keeps the generated JSON schema current", async () => {
    const file = fileURLToPath(new URL("../schemas/check.schema.json", import.meta.url));
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(
      z.toJSONSchema(checkReportSchema, { io: "input" }),
    );
  });
});

describe("possibleMatches", () => {
  const stored = { id: "a:5", key: "k", rules: ["ssrf"], paths: ["src/a.ts"] };

  it("finds a candidate with the same rule anywhere in the project", () => {
    const moved = { id: "b:9", key: "k2", rules: ["ssrf"], paths: ["src/b.ts"] };
    expect(possibleMatches(stored, [stored], [moved])).toEqual(["b:9"]);
  });

  it("finds any candidate in the original file", () => {
    const other = { id: "a:9", key: "k3", rules: ["xss"], paths: ["src/a.ts"] };
    expect(possibleMatches(stored, [stored], [other])).toEqual(["a:9"]);
  });

  it("ignores another stored finding that did not change", () => {
    const other = { id: "a:1", key: "k4", rules: ["ssrf"], paths: ["src/a.ts"] };
    expect(possibleMatches(stored, [stored, other], [other])).toEqual([]);
  });

  it("ignores a candidate with another rule in another file", () => {
    const other = { id: "c:1", key: "k5", rules: ["xss"], paths: ["src/c.ts"] };
    expect(possibleMatches(stored, [stored], [other])).toEqual([]);
  });
});

const SSRF_EVIDENCE = (callee: string): string =>
  `Non-literal URL passed to ${callee}(). Candidate for verification: confirm the destination host is not attacker-controlled (allowlist outbound targets).`;
const TRACED = "Untrusted source reaches this sink (an argument traces to http request input). ";

/** A realistic Fallow SSRF finding. */
const ssrf = (
  file: string,
  line: number,
  shape: { callee?: string; traced?: boolean; category?: string; col?: number } = {},
): SecurityFinding => {
  const callee = shape.callee ?? "fetch";
  const category = shape.category ?? "ssrf";
  const col = shape.col ?? 2;
  return makeFinding({
    finding_id: `security:tainted-sink:${file}:${line}:${col}`,
    path: file,
    line,
    col,
    category,
    cwe: 918,
    evidence: `${shape.traced === true ? TRACED : ""}${SSRF_EVIDENCE(callee)}`,
    trace: [{ path: file, line, col, role: "sink" }],
    candidate: {
      ...makeFinding().candidate,
      sink: { path: file, line, col, category, cwe: 918, callee },
    },
  });
};

describe("check never resolves a finding that can still exist", () => {
  const ambiguousFor = async (before: SecurityFinding[], after: SecurityFinding[]) => {
    const state = await scanned(before);
    const target = before[0]?.finding_id ?? "";
    const engine = engineFor(VULNERABLE);
    const result = await checkWith(
      withFreshScan(after),
      state.loaded,
      state.store,
      options(state, target, engine),
    );
    expect(engine.engine.calls).toBe(0);
    return result.ok ? result.data.report : null;
  };

  it("needs a person after an extract-helper move to another file", async () => {
    // `const u = req.query.u; fetch(u)` in src/a.ts becomes a helper call into src/b.ts.
    const after = ssrf("src/b.ts", 3);
    expect(await ambiguousFor([ssrf("src/a.ts", 2, { traced: true })], [after])).toMatchObject({
      exit_code: 3,
      results: [{ status: "ambiguous", matches: [after.finding_id] }],
    });
  });

  it("needs a person after a callee text change and a line move", async () => {
    // `fetch(url)` becomes `globalThis.fetch(url)` with a new line above it.
    const after = ssrf("src/a.ts", 3, { callee: "globalThis.fetch" });
    expect(await ambiguousFor([ssrf("src/a.ts", 2)], [after])).toMatchObject({
      exit_code: 3,
      results: [{ status: "ambiguous", matches: [after.finding_id] }],
    });
  });

  it("needs a person after a category change for the same sink", async () => {
    // A Fallow upgrade reports the sink under another category and anchor column.
    const after = ssrf("src/a.ts", 2, { category: "outbound-request", col: 8 });
    expect(await ambiguousFor([ssrf("src/a.ts", 2)], [after])).toMatchObject({
      exit_code: 3,
      results: [{ status: "ambiguous", matches: [after.finding_id] }],
    });
  });

  it("resolves the fixed one of two identical calls when the other is unchanged", async () => {
    const other = ssrf("src/a.ts", 4);
    expect(await ambiguousFor([ssrf("src/a.ts", 2), other], [other])).toMatchObject({
      exit_code: 0,
      results: [{ status: "resolved" }],
    });
  });

  it("runs Fallow once for the whole project, with the signal and the target files", async () => {
    const state = await scanned([ssrf("src/a.ts", 2)]);
    const scopes: ScanScope[] = [];
    const controller = new AbortController();
    const adapter: SecurityAdapter = {
      ...securityAdapter,
      scan: {
        ...securityAdapter.scan,
        run: (_loaded, scope) => {
          scopes.push(scope);
          return Promise.resolve(ok(makeOutput([ssrf("src/b.ts", 1)])));
        },
      },
    };
    await checkWith(adapter, state.loaded, state.store, {
      ...options(state, "security:tainted-sink:src/a.ts:2:2", engineFor(VULNERABLE)),
      signal: controller.signal,
    });
    expect(scopes).toEqual([{ signal: controller.signal, exhaustiveIn: ["src/a.ts"] }]);
  });

  it("returns an error, never resolved, when the Fallow run fails", async () => {
    const state = await scanned();
    const adapter: SecurityAdapter = {
      ...securityAdapter,
      scan: {
        ...securityAdapter.scan,
        run: () => Promise.resolve(err(verdictError("fallow_failed", "fallow exited with 2"))),
      },
    };
    expect(
      await checkWith(
        adapter,
        state.loaded,
        state.store,
        options(state, OLD_ID, engineFor(VULNERABLE)),
      ),
    ).toMatchObject({ ok: false, error: { code: "fallow_failed" } });
  });
});

describe("check fatal engine errors", () => {
  const twoFindings = (): SecurityFinding[] => [
    makeFinding({ finding_id: OLD_ID }),
    makeFinding({
      finding_id: "security:tainted-sink:src/routes/user.ts:6:3",
      line: 6,
      col: 3,
      evidence: "res.json receives a non-literal argument",
      candidate: {
        ...makeFinding().candidate,
        sink: { ...makeFinding().candidate.sink, line: 6, col: 3, callee: "res.json" },
      },
    }),
  ];

  it("stops after a rejected key and exits 2", async () => {
    const state = await scanned();
    let calls = 0;
    const engine: DecisionEngine = {
      id: "rejected",
      evaluate: () => {
        calls += 1;
        return Promise.resolve(err(verdictError("engine_auth_failed", "rejected key")));
      },
    };
    const result = await checkWith(
      withFreshScan(twoFindings()),
      state.loaded,
      state.store,
      options(state, SINK_FILE, () => ok(engine)),
    );
    expect(result.ok && result.data.report).toMatchObject({
      exit_code: 2,
      results: [
        { status: "error", error: { code: "engine_auth_failed" } },
        { status: "error", error: { code: "engine_auth_failed" } },
      ],
    });
    expect(calls).toBe(1);
  });

  it("stops after an open circuit on the confirmation call and exits 2", async () => {
    const state = await scanned();
    let calls = 0;
    const safe = mockEngine(() => SAFE_MITIGATED);
    const engine: DecisionEngine = {
      id: "open-circuit",
      evaluate: (request) =>
        calls++ === 0
          ? safe.evaluate(request)
          : Promise.resolve(err(verdictError("engine_circuit_open", "circuit open"))),
    };
    const result = await checkWith(
      withFreshScan(twoFindings()),
      state.loaded,
      state.store,
      options(state, SINK_FILE, () => ok(engine)),
    );
    expect(result.ok && result.data.report).toMatchObject({
      exit_code: 2,
      results: [
        { status: "error", error: { code: "engine_circuit_open" } },
        { status: "error", error: { code: "engine_circuit_open" } },
      ],
    });
    expect(calls).toBe(2);
  });
});

describe("check exit priority", () => {
  it("exits 1, not 3, when one finding stands and another needs a person", async () => {
    const state = await scanned();
    const added = makeFinding({
      finding_id: "security:tainted-sink:src/routes/user.ts:6:3",
      line: 6,
      col: 3,
      evidence: "res.json receives a non-literal argument",
      candidate: {
        ...makeFinding().candidate,
        sink: { ...makeFinding().candidate.sink, line: 6, col: 3, callee: "res.json" },
      },
    });
    const responses = [VULNERABLE, { ...VULNERABLE, tampering: 0.9 }];
    let call = 0;
    const engine = mockEngine(() => responses[call++] ?? VULNERABLE);
    const result = await checkWith(
      withFreshScan([makeFinding({ finding_id: OLD_ID }), added]),
      state.loaded,
      state.store,
      options(state, SINK_FILE, () => ok<DecisionEngine>(engine)),
    );
    expect(result.ok && result.data.report).toMatchObject({
      outcome: "stands",
      exit_code: 1,
      results: [{ verdict: "survivor" }, { verdict: "needs-human-review" }],
    });
  });
});

describe("check dismissal confirmation", () => {
  it("exits 3 when the confirmation call disagrees with a dismissal", async () => {
    const state = await scanned();
    const responses = [SAFE_MITIGATED, VULNERABLE];
    let call = 0;
    const engine = mockEngine(() => responses[call++] ?? VULNERABLE);
    const result = await checkWith(
      withFreshScan([makeFinding({ finding_id: OLD_ID })]),
      state.loaded,
      state.store,
      options(state, OLD_ID, () => ok<DecisionEngine>(engine)),
    );
    expect(result.ok && result.data.report).toMatchObject({
      outcome: "needs-person",
      exit_code: 3,
      results: [{ verdict: "needs-human-review", rule: "dismissal-unconfirmed" }],
    });
    expect(engine.calls).toBe(2);
  });

  it("exits 3 when the confirmation call fails", async () => {
    const state = await scanned();
    let call = 0;
    const safe = mockEngine(() => SAFE_MITIGATED);
    const engine: DecisionEngine = {
      id: "flaky",
      evaluate: (request) =>
        call++ === 0
          ? safe.evaluate(request)
          : Promise.resolve(err(verdictError("engine_unavailable", "down"))),
    };
    const result = await checkWith(
      withFreshScan([makeFinding({ finding_id: OLD_ID })]),
      state.loaded,
      state.store,
      options(state, OLD_ID, () => ok(engine)),
    );
    expect(result.ok && result.data.report).toMatchObject({
      exit_code: 3,
      results: [{ rule: "dismissal-unconfirmed" }],
    });
  });
});

describe("close", () => {
  it("records a judgment by a person that holds until the evidence changes", async () => {
    const state = await scanned();
    const closed = await closeWith(unchanged(), state.loaded, state.store, OLD_ID, "Test code.");
    expect(closed).toMatchObject({
      ok: true,
      data: { closed: { reason: "Test code." } },
    });
    const [record] = (await state.store.readRecords()).records;
    expect(record?.closed?.reason).toBe("Test code.");
    expect(record?.history.at(-1)).toMatchObject({
      by: "person",
      reason: "Test code.",
      rule: "closed-by-person",
    });

    const engine = engineFor(VULNERABLE);
    const adapter = withFreshScan([makeFinding({ finding_id: OLD_ID })]);
    const check = await checkWith(
      adapter,
      state.loaded,
      state.store,
      options(state, OLD_ID, engine),
    );
    expect(check.ok && check.data.report).toMatchObject({
      exit_code: 0,
      results: [{ status: "closed", reason: "Test code." }],
    });
    expect(engine.engine.calls).toBe(0);

    await writeFile(
      path.join(state.root, SINK_FILE),
      SINK_SOURCE.replace("res.json(rows);", "res.json(rows ?? []);"),
    );
    const changed = await checkWith(
      adapter,
      state.loaded,
      state.store,
      options(state, OLD_ID, engine),
    );
    expect(changed.ok && changed.data.report).toMatchObject({
      exit_code: 1,
      results: [{ status: "judged" }],
    });
    expect(await reopenChangedClosures(securityAdapter, state.loaded, state.store)).toEqual(ok(1));
    expect((await state.store.readRecords()).records[0]?.closed).toBeUndefined();
  });

  it("refuses an unknown id and a finding that Fallow no longer reports", async () => {
    const state = await scanned();
    expect(
      await closeWith(unchanged(), state.loaded, state.store, "missing", "Reason."),
    ).toMatchObject({ ok: false, error: { code: "config_invalid" } });
    await syncRecords(state.store, makeOutput([]), false);
    await state.store.writeJson(state.store.candidatesPath, makeOutput([]));
    expect(
      await closeWith(unchanged(), state.loaded, state.store, OLD_ID, "Reason."),
    ).toMatchObject({ ok: false, error: { code: "config_invalid" } });
  });

  it("requires --reason", () => {
    expect(parseCli(["close", OLD_ID])).toMatchObject({ ok: false });
    expect(parseCli(["close", OLD_ID, "--reason", " "])).toMatchObject({ ok: false });
    expect(parseCli(["close", "--reason", "Reason."])).toMatchObject({ ok: false });
    expect(parseCli(["close", OLD_ID, "--reason", "Reason."])).toMatchObject({ ok: true });
  });

  it("shows closed findings in a separate report section", async () => {
    const state = await scanned();
    await judge(
      state.loaded,
      state.store,
      mockEngine(() => VULNERABLE),
      { rejudge: false, dryRun: false },
    );
    await closeWith(unchanged(), state.loaded, state.store, OLD_ID, "Accepted risk.");
    const report = buildReport((await state.store.readRecords()).records, securityPriority);
    expect(report.summary).toMatchObject({ candidates: 1, survivors: 0, closed: 1 });
    expect(report.findings).toEqual([]);
    expect(report.closed?.map((record) => record.finding_id)).toEqual([OLD_ID]);
    const human = renderHuman(report, securityPresentation, false);
    expect(human).toContain("Closed by a person (1)");
    expect(human).toContain("Accepted risk.");
    expect(renderMarkdown(report, securityPresentation)).toContain("## Closed by a person (1)");
  });

  it("keeps a closed finding out of judge until its evidence changes", async () => {
    const state = await scanned();
    await closeWith(unchanged(), state.loaded, state.store, OLD_ID, "Test code.");
    const engine = mockEngine(() => VULNERABLE);
    const plans: number[] = [];
    const dry = await judge(state.loaded, state.store, engine, {
      rejudge: false,
      dryRun: true,
      onProgress: (event) => {
        if (event.type === "plan") plans.push(event.toJudge);
      },
    });
    expect(dry.ok && dry.data).toMatchObject({ pending: 0, estimatedUsd: 0 });
    await judge(state.loaded, state.store, engine, { rejudge: true, dryRun: false });
    expect(plans).toEqual([0]);
    expect(engine.calls).toBe(0);

    await writeFile(
      path.join(state.root, SINK_FILE),
      SINK_SOURCE.replace("res.json(rows);", "res.json(rows ?? []);"),
    );
    await judge(state.loaded, state.store, engine, { rejudge: false, dryRun: false });
    expect(engine.calls).toBe(1);
  });

  it("exports a closed finding to Fallow as dismissed with the reason of the person", async () => {
    const state = await scanned();
    await closeWith(unchanged(), state.loaded, state.store, OLD_ID, "Accepted risk.");
    const { records } = await state.store.readRecords();
    expect(toVerdictsFile(records, new Set([OLD_ID])).verdicts).toEqual([
      expect.objectContaining({
        finding_id: OLD_ID,
        verdict: "dismissed",
        reason: "Closed by a person: Accepted risk.",
        dismissal_reason: "closed-by-person",
      }),
    ]);
  });

  it("removes a stale closure when judge assesses the finding again", async () => {
    const state = await scanned();
    await closeWith(unchanged(), state.loaded, state.store, OLD_ID, "Test code.");
    await writeFile(
      path.join(state.root, SINK_FILE),
      SINK_SOURCE.replace("res.json(rows);", "res.json(rows ?? []);"),
    );
    await judge(
      state.loaded,
      state.store,
      mockEngine(() => VULNERABLE),
      { rejudge: false, dryRun: false },
    );
    const { records } = await state.store.readRecords();
    expect(records[0]?.closed).toBeUndefined();
    const status = buildReport(records, securityPriority);
    expect(status.summary).toMatchObject({ survivors: 1 });
    expect(status.summary.closed).toBeUndefined();
  });

  it("refuses to close when the code moved after the last scan", async () => {
    const state = await scanned();
    await writeFile(path.join(state.root, SINK_FILE), MOVED_SOURCE);
    expect(
      await closeWith(withFreshScan([movedFinding()]), state.loaded, state.store, OLD_ID, "Why."),
    ).toMatchObject({
      ok: false,
      error: { code: "config_invalid", hint: expect.stringContaining("scan") },
    });
    expect((await state.store.readRecords()).records[0]?.closed).toBeUndefined();
  });
});
