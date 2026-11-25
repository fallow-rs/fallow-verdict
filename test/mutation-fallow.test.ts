import { describe, expect, it } from "vitest";

import {
  mutationCandidates,
  parseMutationInspect,
  parseMutationTasks,
  runMutationInspect,
  runMutationTasks,
  type MutationTasksOutput,
} from "../src/fallow/mutation.ts";
import { readFixture, REPLAY_UNSUPPORTED, stubProject } from "./mutation-helpers.ts";

const tasks = async (): Promise<MutationTasksOutput> => {
  const parsed = parseMutationTasks(await readFixture("tasks.json"));
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.data;
};

describe("fallow mutation tasks", () => {
  it("takes only the survived tasks as candidates", async () => {
    const output = await tasks();
    const [first, second] = output.tasks;
    if (first === undefined || second === undefined) throw new Error("fixture");
    const mixed = { ...output, tasks: [first, { ...second, status: "no_coverage" as const }] };
    expect(mutationCandidates(mixed).map((task) => task.mutant_id)).toEqual([first.mutant_id]);
  });

  it.each([
    [{ schema_version: "2" }, "fallow_schema_unsupported"],
    [{ schema_version: undefined }, "fallow_schema_unsupported"],
    [{ tasks: "none" }, "fallow_output_invalid"],
  ])("refuses an unsupported document %o", async (patch, code) => {
    const parsed = parseMutationTasks({ ...(await tasks()), ...patch });
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error.code).toBe(code);
  });

  it("refuses a task without an id and duplicate ids", async () => {
    const output = await tasks();
    const [first] = output.tasks;
    if (first === undefined) throw new Error("fixture");
    const noId = parseMutationTasks({ ...output, tasks: [{ ...first, mutant_id: " " }] });
    expect(!noId.ok && noId.error.code).toBe("fallow_output_invalid");
    const twice = parseMutationTasks({ ...output, tasks: [first, first] });
    expect(!twice.ok && twice.error.message).toContain("duplicate");
    expect(parseMutationTasks(output).ok).toBe(true);
  });

  it("keeps the tasks inside the path scope", async () => {
    const project = await stubProject();
    const all = await runMutationTasks({
      root: project.root,
      binary: project.loaded.config.fallow.binary,
    });
    const files = all.ok ? new Set(all.data.tasks.map((task) => task.file)) : new Set();
    expect(files).toEqual(
      new Set(["src/counter.ts", "src/list.ts", "src/settings.ts", "src/text.ts"]),
    );
    const scoped = await runMutationTasks({
      root: project.root,
      binary: project.loaded.config.fallow.binary,
      paths: ["src/text.ts", "src/settings.ts"],
    });
    expect(
      scoped.ok && [...new Set(scoped.data.tasks.map((task) => task.file))].toSorted(),
    ).toEqual(["src/settings.ts", "src/text.ts"]);
    expect((await project.calls())[0]).toEqual([
      "mutation",
      "tasks",
      "--format",
      "json",
      "--quiet",
    ]);
  });
});

describe("fallow mutation inspect", () => {
  it("validates the envelope and the mutant id", async () => {
    const packet = (await readFixture("inspect/e66b12a385a0c071.json")) as Record<string, unknown>;
    expect(parseMutationInspect(packet, "e66b12a385a0c071").ok).toBe(true);
    const wrongId = parseMutationInspect(packet, "0000000000000000");
    expect(!wrongId.ok && wrongId.error.code).toBe("fallow_output_invalid");
    const oldSchema = parseMutationInspect({ ...packet, schema_version: "1" }, "e66b12a385a0c071");
    expect(!oldSchema.ok && oldSchema.error.code).toBe("fallow_schema_unsupported");
    const wrongKind = parseMutationInspect({ ...packet, kind: "mutation" }, "e66b12a385a0c071");
    expect(!wrongKind.ok && wrongKind.error.code).toBe("fallow_output_invalid");
  });

  it("passes --replay only when asked and names the Fallow error code of a failed replay", async () => {
    const project = await stubProject();
    const invocation = { root: project.root, binary: project.loaded.config.fallow.binary };
    const plain = await runMutationInspect({
      ...invocation,
      mutantId: "c9cdd0a284339dca",
      replay: false,
    });
    expect(plain.ok && plain.data.replay).toBeUndefined();
    const replay = await runMutationInspect({
      ...invocation,
      mutantId: "c9cdd0a284339dca",
      replay: true,
    });
    expect(replay.ok && replay.data.replay?.verdict).toBe("witness");
    await project.setInspect("c9cdd0a284339dca", REPLAY_UNSUPPORTED, true);
    const failed = await runMutationInspect({
      ...invocation,
      mutantId: "c9cdd0a284339dca",
      replay: true,
    });
    expect(failed.ok).toBe(false);
    expect(!failed.ok && failed.fallowCode).toBe("FALLOW_MUTATION_REPLAY_UNSUPPORTED");
    expect((await project.calls()).map((args) => args.includes("--replay"))).toEqual([
      false,
      true,
      true,
    ]);
  });
});
