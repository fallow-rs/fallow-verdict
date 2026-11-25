import type {
  MutationInspectOutput,
  MutationReplayOutput,
  MutationTask,
  MutationTasksOutput,
} from "fallow/types";

import { verdictError, type VerdictError } from "../util/errors.ts";
import { isInside } from "../util/files.ts";
import { err, ok, type Result } from "../util/result.ts";
import { capture, parseJson, resolveFallowBinary, type FallowInvocation } from "./run.ts";

export type { MutationInspectOutput, MutationReplayOutput, MutationTask, MutationTasksOutput };

/** `fallow mutation tasks` schema versions this release was verified against. */
const SUPPORTED_MUTATION_TASKS_SCHEMA_VERSIONS: readonly string[] = ["1"];

/** `fallow mutation inspect` schema versions this release was verified against. */
const SUPPORTED_MUTATION_INSPECT_SCHEMA_VERSIONS: readonly string[] = ["2"];

/** The verdict document version that `fallow mutation --verdicts` accepts. */
export const MUTATION_VERDICT_SCHEMA = "1";

const INSPECT_KIND = "mutation-inspect";

/** Inspect and tasks read files only, but a replay starts a runner, so it gets a long window. */
const DEFAULT_TIMEOUT_MS = 300_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const unsupported = (command: string, version: unknown, supported: readonly string[]) =>
  verdictError(
    "fallow_schema_unsupported",
    `fallow mutation ${command} schema_version ${String(version)} is not supported (supported: ${supported.join(", ")}).`,
    "Upgrade fallow-verdict, or pin a fallow version it supports.",
  );

/** The type of each task field that the kind reads. */
const TASK_FIELDS: Readonly<Record<string, "string" | "number">> = {
  mutant_id: "string",
  file: "string",
  line: "number",
  column: "number",
  operator: "string",
  status: "string",
};

const isTask = (value: unknown): boolean =>
  isRecord(value) &&
  Object.entries(TASK_FIELDS).every(([field, type]) => typeof value[field] === type) &&
  String(value["mutant_id"]).trim().length > 0 &&
  String(value["file"]).length > 0 &&
  Array.isArray(value["covering_test_files"]);

/** Validate the envelope and the task identities; other fields follow Fallow's contract. */
export const parseMutationTasks = (value: unknown): Result<MutationTasksOutput, VerdictError> => {
  if (!isRecord(value) || !Array.isArray(value["tasks"]))
    return err(
      verdictError(
        "fallow_output_invalid",
        "Expected `fallow mutation tasks --format json` output with `tasks`.",
      ),
    );
  if (!SUPPORTED_MUTATION_TASKS_SCHEMA_VERSIONS.includes(String(value["schema_version"])))
    return err(
      unsupported("tasks", value["schema_version"], SUPPORTED_MUTATION_TASKS_SCHEMA_VERSIONS),
    );
  const seen = new Set<string>();
  for (const task of value["tasks"]) {
    if (!isTask(task))
      return err(
        verdictError(
          "fallow_output_invalid",
          "Each mutation task needs a mutant_id, a file, a line, a column, an operator, a status and covering_test_files.",
        ),
      );
    const id = (task as MutationTask).mutant_id;
    if (seen.has(id))
      return err(
        verdictError(
          "fallow_output_invalid",
          "Fallow returned duplicate mutant IDs. Separate mutants cannot share a verdict record.",
          "Update fallow and run `fallow mutation` again.",
        ),
      );
    seen.add(id);
  }
  return ok(value as unknown as MutationTasksOutput);
};

/**
 * The candidates: the `survived` tasks. A `no_coverage` mutant needs a test that runs the code,
 * not an assessment of equivalence.
 */
export const mutationCandidates = (output: MutationTasksOutput): MutationTask[] =>
  output.tasks.filter((task) => task.status === "survived");

/** Only a complete report proves that a mutant without a task is no longer open. */
export const isCompleteReport = (output: MutationTasksOutput): boolean =>
  output.report_completion === "complete";

/** Validate one inspect packet for the requested mutant. */
export const parseMutationInspect = (
  value: unknown,
  mutantId: string,
): Result<MutationInspectOutput, VerdictError> => {
  if (!isRecord(value) || value["kind"] !== INSPECT_KIND)
    return err(
      verdictError(
        "fallow_output_invalid",
        "Expected `fallow mutation inspect --format json` output.",
      ),
    );
  if (!SUPPORTED_MUTATION_INSPECT_SCHEMA_VERSIONS.includes(String(value["schema_version"])))
    return err(
      unsupported("inspect", value["schema_version"], SUPPORTED_MUTATION_INSPECT_SCHEMA_VERSIONS),
    );
  if (
    value["mutant_id"] !== mutantId ||
    (value["status"] !== "fresh" && value["status"] !== "stale")
  )
    return err(
      verdictError(
        "fallow_output_invalid",
        "fallow mutation inspect did not return a packet for the requested mutant.",
      ),
    );
  return ok(value as unknown as MutationInspectOutput);
};

/** The message and code of a Fallow JSON error on stdout, else stderr, else the start of stdout. */
const failureOf = (stdout: string, stderr: string): { detail: string; code: string | null } => {
  const parsed = parseJson(stdout);
  if (parsed.ok && isRecord(parsed.data) && typeof parsed.data["message"] === "string")
    return {
      detail: parsed.data["message"],
      code: typeof parsed.data["code"] === "string" ? parsed.data["code"] : null,
    };
  return { detail: stderr.trim() || stdout.trim().slice(0, 400), code: null };
};

/**
 * Reads the open tasks of the report that the last `fallow mutation` run saved. It runs no
 * project code. A path scope keeps the tasks in those files or directories.
 */
export const runMutationTasks = async (
  options: FallowInvocation & { paths?: readonly string[] | undefined },
): Promise<Result<MutationTasksOutput, VerdictError>> => {
  const binary = resolveFallowBinary(options.root, options.binary);
  const captured = await capture(
    binary,
    ["mutation", "tasks", "--format", "json", "--quiet"],
    options.root,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    options.signal,
  );
  if (!captured.ok) return captured;
  if (captured.data.code !== 0) {
    const failure = failureOf(captured.data.stdout, captured.data.stderr);
    return err(
      verdictError(
        "fallow_failed",
        `fallow mutation tasks exited with ${captured.data.code}: ${failure.detail}`,
        failure.code === "FALLOW_MUTATION_NO_REPORT"
          ? "Run `fallow mutation` first. fallow-verdict reads the report that it saves."
          : undefined,
      ),
    );
  }
  const parsed = parseJson(captured.data.stdout);
  if (!parsed.ok) return parsed;
  const output = parseMutationTasks(parsed.data);
  const paths = options.paths ?? [];
  if (!output.ok || paths.length === 0) return output;
  return ok({
    ...output.data,
    tasks: output.data.tasks.filter((task) =>
      paths.some((scope) => isInside(options.root, scope, task.file)),
    ),
  });
};

/** A failed inspect also names the Fallow error code, so a caller can tell a replay failure apart. */
export type InspectResult =
  | { ok: true; data: MutationInspectOutput }
  | { ok: false; error: VerdictError; fallowCode: string | null };

/**
 * Runs `fallow mutation inspect` for one mutant of the saved report. `replay` adds `--replay`,
 * which runs project code: the module of the file and each module that it imports.
 */
export const runMutationInspect = async (
  options: FallowInvocation & { mutantId: string; replay: boolean },
): Promise<InspectResult> => {
  const binary = resolveFallowBinary(options.root, options.binary);
  const captured = await capture(
    binary,
    [
      "mutation",
      "inspect",
      options.mutantId,
      ...(options.replay ? ["--replay"] : []),
      "--format",
      "json",
      "--quiet",
    ],
    options.root,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    options.signal,
  );
  if (!captured.ok) return { ...captured, fallowCode: null };
  if (captured.data.code !== 0) {
    const failure = failureOf(captured.data.stdout, captured.data.stderr);
    return {
      ok: false,
      error: verdictError("fallow_failed", `fallow mutation inspect failed: ${failure.detail}`),
      fallowCode: failure.code,
    };
  }
  const parsed = parseJson(captured.data.stdout);
  if (!parsed.ok) return { ...parsed, fallowCode: null };
  const packet = parseMutationInspect(parsed.data, options.mutantId);
  return packet.ok ? packet : { ...packet, fallowCode: null };
};
