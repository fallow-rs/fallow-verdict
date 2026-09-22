import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { SecurityFinding } from "../src/fallow/types.ts";
import { buildPacket, type BuiltPacket } from "../src/packet/build.ts";
import { judge } from "../src/pipeline/judge.ts";
import { syncRecords } from "../src/pipeline/scan.ts";
import { decide } from "../src/policy/decide.ts";
import { openStore } from "../src/state/store.ts";
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

type Surface = NonNullable<SecurityFinding["attack_surface"]>;

const CONTROL_FILE = "src/validate.ts";
const options = { radius: 20, maxStateTokens: 28_000, blind: false };
const makeSurface = (finding = makeFinding()): Surface => ({
  source: { path: "src/input.ts", line: 1, col: 0 },
  sink: finding.candidate.sink,
  path: [{ path: "src/route.ts", line: 1, col: 0, role: "intermediate" }],
  defensive_boundary: {
    controls: [{ kind: "validation", path: CONTROL_FILE, line: 1, col: 0, callee: "validate" }],
    verification_prompt: "Check whether validation applies to this value.",
  },
});
const project = (): Promise<string> =>
  makeProject({
    [SINK_FILE]: SINK_SOURCE,
    [CONTROL_FILE]: "export const validate = (value) => Number(value);",
    "src/input.ts": "export const input = request.query.value;",
    "src/route.ts": "export const route = (value) => handler(validate(value));",
  });
const build = (
  root: string,
  surfaces: Surface[],
  finding = makeFinding(),
  maxStateTokens = options.maxStateTokens,
): Promise<BuiltPacket> =>
  buildPacket(
    finding,
    { ...makeOutput([finding]), attack_surface: surfaces },
    { root, ...options, maxStateTokens },
  );

describe("top-level attack-surface evidence", () => {
  it("sends file-level control observations without treating them as protection for the sink", async () => {
    const root = await project();
    const unrelatedGuard =
      'export const unrelated = (url) => { if (url.origin !== "https://trusted.example") throw new Error(); };';
    await writeFile(path.join(root, CONTROL_FILE), unrelatedGuard);
    const finding = makeFinding();
    const surface = makeSurface(finding);
    surface.defensive_boundary.controls = surface.defensive_boundary.controls.map((control) => ({
      ...control,
      callee: "origin-equality-guard",
    }));
    const loaded = makeLoaded(root);
    const store = openStore(loaded.dataDir);
    const output = { ...makeOutput([finding]), attack_surface: [surface] };
    await store.writeJson(store.candidatesPath, output);
    await syncRecords(store, output, false, loaded);
    const engine = mockEngine((state) => {
      expect(state).toMatchObject({
        defensive_controls_scope: {
          discovery: "files-on-trace",
          applicability_to_sink: "not-established",
        },
        defensive_controls: [{ callee: "origin-equality-guard" }],
        source_windows: expect.arrayContaining([expect.objectContaining({ path: CONTROL_FILE })]),
      });
      expect(JSON.stringify(state)).toContain("export const unrelated");
      return VULNERABLE;
    });
    await judge(loaded, store, engine, { rejudge: false, dryRun: false });
    expect(engine.calls).toBe(1);
    expect((await store.readRecords()).records[0]?.decision?.verdict).toBe("survivor");
  });

  it("includes controls and source paths emitted by the real CLI envelope", async () => {
    const result = await build(await project(), [makeSurface()]);
    expect(result.packet.defensive_controls).toEqual(makeSurface().defensive_boundary.controls);
    expect(result.packet.source_windows.map((window) => window.path)).toEqual(
      expect.arrayContaining([CONTROL_FILE, "src/input.ts", "src/route.ts"]),
    );
    expect(result.unreadable).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("matches the complete sink identity and excludes client-server findings", async () => {
    const root = await project();
    const surface = makeSurface();
    for (const sink of [
      { ...surface.sink, path: "src/elsewhere.ts" },
      { ...surface.sink, line: surface.sink.line + 1 },
      { ...surface.sink, col: surface.sink.col + 1 },
      { ...surface.sink, category: "header-injection" },
    ]) {
      expect((await build(root, [{ ...surface, sink }])).packet.defensive_controls).toEqual([]);
    }
    expect(
      (await build(root, [surface], makeFinding({ kind: "client-server-leak" }))).packet
        .defensive_controls,
    ).toEqual([]);
  });

  it("preserves legacy inline surfaces and is stable across duplicate and reordered routes", async () => {
    const root = await project();
    const first = makeSurface();
    const second = { ...first, source: { ...first.source, col: 5 } };
    const original = await build(root, [first, second]);
    const reordered = await build(root, [second, first, first]);
    expect(reordered.fingerprint).toBe(original.fingerprint);
    expect(reordered.packet.defensive_controls).toEqual(first.defensive_boundary.controls);
    expect(
      (await build(root, [], makeFinding({ attack_surface: first }))).packet.defensive_controls,
    ).toEqual(first.defensive_boundary.controls);
  });

  it("fingerprints control content and surface metadata even when source windows coincide", async () => {
    const root = await project();
    const surface = makeSurface();
    const first = await build(root, [surface]);
    const changedSource = await build(root, [
      { ...surface, source: { ...surface.source, col: 5 } },
    ]);
    expect(changedSource.fingerprint).not.toBe(first.fingerprint);
    await writeFile(path.join(root, CONTROL_FILE), "export const validate = (value) => value;");
    expect((await build(root, [surface])).fingerprint).not.toBe(first.fingerprint);
  });

  it("invalidates a cached dismissal when only an external control changes", async () => {
    const root = await project();
    const loaded = makeLoaded(root);
    const store = openStore(loaded.dataDir);
    const finding = makeFinding();
    const output = { ...makeOutput([finding]), attack_surface: [makeSurface(finding)] };
    await store.writeJson(store.candidatesPath, output);
    await syncRecords(store, output, false, loaded);
    const engine = mockEngine(() => SAFE_MITIGATED);
    await judge(loaded, store, engine, { rejudge: false, dryRun: false });
    expect((await store.readRecords()).records[0]?.decision?.verdict).toBe("dismissed");
    await writeFile(path.join(root, CONTROL_FILE), "export const validate = (value) => value;");
    await judge(loaded, store, engine, { rejudge: false, dryRun: false, maxCostUsd: 0 });
    expect((await store.readRecords()).records[0]).toMatchObject({
      status: "pending",
      decision: null,
    });
  });

  it("refuses escaped control files and marks missing evidence", async () => {
    const root = await project();
    const outside = await makeProject({ "secret.ts": "TOP SECRET" });
    await mkdir(path.join(root, "linked"));
    await symlink(path.join(outside, "secret.ts"), path.join(root, "linked/control.ts"));
    const surface = makeSurface();
    surface.defensive_boundary.controls = surface.defensive_boundary.controls.map((control) => ({
      ...control,
      path: "linked/control.ts",
    }));
    const result = await build(root, [surface]);
    expect(result.unreadable).toContain("linked/control.ts");
    expect(JSON.stringify(result.packet)).not.toContain("TOP SECRET");
    expect(decide(answersFor(SAFE_MITIGATED), result, makeLoaded(root).config.policy).verdict).toBe(
      "needs-human-review",
    );
  });

  it("marks packets truncated when additional surface evidence forces a budget cut", async () => {
    const root = await project();
    await writeFile(
      path.join(root, CONTROL_FILE),
      Array.from(
        { length: 100 },
        () => "const input = validateExternalInput(request.query.value);",
      ).join("\n"),
    );
    const full = await build(root, [makeSurface()]);
    const result = await build(root, [makeSurface()], makeFinding(), full.stateTokens - 100);
    expect(result.truncated).toBe(true);
    expect(result.stateTokens).toBeLessThanOrEqual(full.stateTokens - 100);
    expect(decide(answersFor(SAFE_MITIGATED), result, makeLoaded(root).config.policy).verdict).toBe(
      "needs-human-review",
    );
  });
});
