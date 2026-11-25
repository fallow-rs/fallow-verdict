import { createHash } from "node:crypto";
import { appendFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  parseMutationTasks,
  type MutationInspectOutput,
  type MutationTask,
} from "../src/fallow/mutation.ts";
import { buildMutantPacket, mutantFromInspect } from "../src/packet/mutation.ts";
import {
  readFixture,
  REPLAY_UNSUPPORTED,
  stubProject,
  type StubProject,
} from "./mutation-helpers.ts";

const taskOf = async (id: string): Promise<MutationTask> => {
  const parsed = parseMutationTasks(await readFixture("tasks.json"));
  const task = parsed.ok ? parsed.data.tasks.find((entry) => entry.mutant_id === id) : undefined;
  if (task === undefined) throw new Error(`no task ${id}`);
  return task;
};

const build = (project: StubProject, task: MutationTask, replay = false, readOnly = false) =>
  buildMutantPacket(
    task,
    { root: project.root, binary: project.loaded.config.fallow.binary },
    { replay, cacheDir: path.join(project.root, ".cache"), readOnly },
  );

const replayCalls = async (project: StubProject): Promise<number> =>
  (await project.calls()).filter((args) => args.includes("--replay")).length;

describe("mutation packet", () => {
  it("holds the whole enclosing function, the change and the tests that name it", async () => {
    const project = await stubProject();
    const built = await build(project, await taskOf("c9cdd0a284339dca"));
    expect(built.truncated).toBe(false);
    expect(built.evidence).toEqual({ stale: false, truncated: false, witness: null });
    const { packet } = built;
    expect(packet.mutant.original_lines).toBe("  return items.slice(offset, offset + size);");
    expect(packet.mutant.mutated_lines).toBe("  return items.slice(offset, offset - size);");
    expect(packet.function_source).toMatchObject({
      path: "src/list.ts",
      start_line: 2,
      end_line: 5,
    });
    expect(packet.function_source?.text).toContain(
      "if (items.length >= 0 && offset >= items.length)",
    );
    expect(packet.function_source?.text).not.toContain("countWhere");
    expect(packet.tests.files).toEqual(["test/list.test.ts"]);
    expect(packet.tests.excerpts[0]?.text).toContain("expect(page([1, 2, 3, 4], 1, 2))");
    expect(packet.omissions).toEqual([]);
  });

  it.each([
    [
      "a top-level name, not the names that the function binds itself",
      [
        "const LIMIT = 3;",
        "const local = 9;",
        "const count = 0;",
        "export const over = (count: number): boolean => {",
        "  const local = 1;",
        "  return count + local > LIMIT;",
        "};",
      ],
      4,
      6,
      "count + local > LIMIT",
      ["1| const LIMIT = 3;"],
    ],
    [
      "a name in the body of a one-line function",
      ["const DEFAULTS = 1;", "export const f = (x?: number) => x ?? DEFAULTS;"],
      2,
      2,
      "x ?? DEFAULTS",
      ["1| const DEFAULTS = 1;"],
    ],
    [
      "the iterated name of a for-of loop",
      [
        "const LIST = [1];",
        "export const g = (): void => {",
        "  for (const k of LIST) use(k);",
        "};",
      ],
      2,
      3,
      "LIST",
      ["1| const LIST = [1];"],
    ],
  ])(
    "adds the same-file declaration of %s",
    async (_name, lines, functionLine, line, span, expected) => {
      const source = Buffer.from(`${lines.join("\n")}\n`);
      const inspect = (await readFixture("inspect/0ab0249adef9e6e3.json")) as MutationInspectOutput;
      const built = mutantFromInspect({
        task: { ...(await taskOf("0ab0249adef9e6e3")), line, function: "f" },
        inspect: {
          ...inspect,
          line,
          function: "f",
          function_line: functionLine,
          current_sha256: createHash("sha256").update(source).digest("hex"),
          code: { original: span, replacement: "true", original_lines: "", mutated_lines: "" },
        },
        failure: null,
        replay: null,
        replayFailure: null,
        source,
        tests: { excerpts: [], omitted: 0, digests: {} },
      });
      expect(built.packet.function_source?.start_line).toBe(functionLine);
      expect(built.packet.declarations.map((entry) => entry.text.trim())).toEqual(expected);
    },
  );

  it("gives a stale packet without code when Fallow reports the file as changed", async () => {
    const project = await stubProject();
    await project.setInspect("0cb13f9350cad239", await readFixture("stale-0cb13f9350cad239.json"));
    const built = await build(project, await taskOf("0cb13f9350cad239"));
    expect(built.evidence.stale).toBe(true);
    expect(built.truncated).toBe(true);
    expect(built.packet.mutant.original_lines).toBeNull();
    expect(built.packet.function_source).toBeNull();
    expect(built.packet.omissions).toEqual(["stale (source-changed)"]);
  });

  it("gives a stale packet when the file changed after inspect", async () => {
    const project = await stubProject();
    const task = await taskOf("0ab0249adef9e6e3");
    expect((await build(project, task)).evidence.stale).toBe(false);
    await appendFile(path.join(project.root, "src/text.ts"), "// edit\n");
    const built = await build(project, task);
    expect(built.evidence.stale).toBe(true);
    expect(built.packet.function_source).toBeNull();
  });

  it("gives a stale packet when the saved report no longer lists the mutant as survived", async () => {
    const project = await stubProject();
    const inspect = (await readFixture("inspect/0ab0249adef9e6e3.json")) as Record<string, unknown>;
    await project.setInspect("0ab0249adef9e6e3", { ...inspect, report_status: "killed" });
    const built = await build(project, await taskOf("0ab0249adef9e6e3"));
    expect(built.evidence.stale).toBe(true);
    expect(built.packet.omissions).toEqual(["stale (report status killed)"]);
    expect(built.packet.tests.covering).toEqual([]);
  });

  it("caches a replay failure with a Fallow code, so a rebuild does not replay again", async () => {
    const project = await stubProject();
    await project.setInspect("c9cdd0a284339dca", REPLAY_UNSUPPORTED, true);
    const task = await taskOf("c9cdd0a284339dca");
    const first = await build(project, task, true);
    const second = await build(project, task, true);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.packet.omissions).toEqual([
      "replay unavailable (FALLOW_MUTATION_REPLAY_UNSUPPORTED)",
    ]);
    expect(await replayCalls(project)).toBe(1);
  });

  it("gives a stale packet when inspect fails", async () => {
    const project = await stubProject();
    const task = { ...(await taskOf("0ab0249adef9e6e3")), mutant_id: "ffffffffffffffff" };
    const built = await build(project, task);
    expect(built.evidence.stale).toBe(true);
    expect(built.packet.omissions).toEqual(["inspect failed (FALLOW_MUTATION_UNKNOWN_MUTANT)"]);
  });

  it("runs no replay by default", async () => {
    const project = await stubProject();
    const built = await build(project, await taskOf("c9cdd0a284339dca"));
    expect(built.evidence.witness).toBeNull();
    expect(await replayCalls(project)).toBe(0);
  });

  it("takes a replay witness, keeps its input out of the packet, and caches the replay", async () => {
    const project = await stubProject();
    const task = await taskOf("c9cdd0a284339dca");
    const built = await build(project, task, true);
    expect(built.evidence.witness).toEqual({
      source: "replay",
      input: [[1, 2, 3], 0, 2],
      original: { outcome: "returned", text: "[ 1, 2 ]" },
      mutant: { outcome: "returned", text: "[ 1 ]" },
    });
    expect(built.packet.replay).toEqual({
      verdict: "witness",
      reason: null,
      export: "page",
      inputs_checked: 1,
    });
    expect(JSON.stringify(built.packet)).not.toContain("[[1,2,3],0,2]");
    const again = await build(project, task, true);
    expect(again.fingerprint).toBe(built.fingerprint);
    expect(await replayCalls(project)).toBe(1);
  });

  it("does not write the replay cache in read-only mode", async () => {
    const project = await stubProject();
    const task = await taskOf("c9cdd0a284339dca");
    await build(project, task, true, true);
    await build(project, task, true, true);
    expect(await replayCalls(project)).toBe(2);
    expect(await readdir(path.join(project.root, ".cache")).catch(() => [])).toEqual([]);
  });

  it("keeps a run without replay support going, with the reason in the packet", async () => {
    const project = await stubProject();
    await project.setInspect("c9cdd0a284339dca", REPLAY_UNSUPPORTED, true);
    const built = await build(project, await taskOf("c9cdd0a284339dca"), true);
    expect(built.evidence).toEqual({ stale: false, truncated: false, witness: null });
    expect(built.packet.replay).toBeNull();
    expect(built.packet.omissions).toEqual([
      "replay unavailable (FALLOW_MUTATION_REPLAY_UNSUPPORTED)",
    ]);
  });

  it("puts a replay without a witness into the packet as evidence only", async () => {
    const project = await stubProject();
    const built = await build(project, await taskOf("0ab0249adef9e6e3"), true);
    expect(built.evidence.witness).toBeNull();
    expect(built.packet.replay?.verdict).toBe("no_witness_found");
    expect(JSON.stringify(built.packet)).not.toContain('"ab"');
  });

  it("takes the witness of a recording run from the task", async () => {
    const project = await stubProject();
    const task: MutationTask = {
      ...(await taskOf("0ab0249adef9e6e3")),
      witness: {
        verdict: "witness",
        inputs_checked: 1,
        replay_command: "fallow mutation inspect 0ab0249adef9e6e3 --replay",
        args: ["abc", 3],
        original: { outcome: "returned", value: "abc", text: "'abc'" },
        mutant: { outcome: "returned", value: "abc...", text: "'abc...'" },
      },
    };
    const built = await build(project, task);
    expect(built.evidence.witness).toEqual({
      source: "run",
      input: ["abc", 3],
      original: { outcome: "returned", text: "'abc'" },
      mutant: { outcome: "returned", text: "'abc...'" },
    });
    const stale = await build(project, { ...task, stale_reason: "source-changed" });
    expect(stale.evidence.witness).toBeNull();
  });

  it("changes the fingerprint when a covering test file changes", async () => {
    const project = await stubProject();
    const task = await taskOf("d8d14c2ade9279b6");
    const before = await build(project, task);
    expect((await build(project, task)).fingerprint).toBe(before.fingerprint);
    await appendFile(path.join(project.root, "test/list.test.ts"), "// more tests\n");
    expect((await build(project, task)).fingerprint).not.toBe(before.fingerprint);
  });
});
