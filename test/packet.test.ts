import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildPacket } from "../src/packet/build.ts";
import { makeFinding, makeOutput, makeProject, SINK_FILE, SINK_SOURCE } from "./helpers.ts";

const options = { radius: 20, maxStateTokens: 28_000, blind: false };

const build = async (root: string, finding = makeFinding(), overrides = {}) =>
  buildPacket(finding, makeOutput([finding]), { root, ...options, ...overrides });

describe("buildPacket", () => {
  it("sends each source line once, numbered, with the roles it serves", async () => {
    const { packet } = await build(await makeProject());
    expect(packet.source_windows).toHaveLength(1);
    const [window] = packet.source_windows;
    expect(window?.roles).toEqual(["sink", "source"]);
    expect(window?.text).toContain("    5|   const rows = await db.query");
  });

  it("keeps the same fingerprint for the same evidence and changes it when code changes", async () => {
    const root = await makeProject();
    const first = await build(root);
    expect((await build(root)).fingerprint).toBe(first.fingerprint);

    await writeFile(path.join(root, SINK_FILE), SINK_SOURCE.replace("${id}", "${Number(id)}"));
    expect((await build(root)).fingerprint).not.toBe(first.fingerprint);
  });

  it("refuses to read files outside the project root", async () => {
    const root = await makeProject();
    const outside = await makeProject({ "secret.txt": "TOP SECRET\n" });
    await mkdir(path.join(root, "linked"), { recursive: true });
    await symlink(path.join(outside, "secret.txt"), path.join(root, "linked/secret.ts"));

    for (const escape of ["../../etc/passwd", "linked/secret.ts"]) {
      const finding = makeFinding({
        trace: [{ path: escape, line: 1, col: 0, role: "intermediate" }],
      });
      const result = await build(root, finding);
      expect(result.unreadable).toContain(escape);
      expect(JSON.stringify(result.packet)).not.toContain("TOP SECRET");
    }
  });

  it("shrinks evidence to fit the budget and says so", async () => {
    const long = Array.from({ length: 400 }, (_unused, index) => `const value${index} = ${index};`);
    const root = await makeProject({ [SINK_FILE]: long.join("\n") });
    const finding = makeFinding({
      line: 200,
      candidate: { ...makeFinding().candidate, sink: { path: SINK_FILE, line: 200, col: 0 } },
      trace: [{ path: SINK_FILE, line: 20, col: 0, role: "intermediate" }],
    });
    const result = await build(root, finding, { maxStateTokens: 1_000 });
    expect(result.truncated).toBe(true);
    expect(result.stateTokens).toBeLessThanOrEqual(1_000);
    expect(result.packet.source_windows.some((window) => window.roles.includes("sink"))).toBe(true);
  });

  it("withholds fallow's classification in blind mode", async () => {
    const { packet } = await build(await makeProject(), makeFinding(), { blind: true });
    expect(packet.category).toBeNull();
    expect(packet.evidence).toBeNull();
    expect(packet.candidate.sink.category).toBeNull();
    expect(packet.candidate.sink.callee).toBe("db.query");
  });
});
