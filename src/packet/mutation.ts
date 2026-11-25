import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  runMutationInspect,
  type MutationInspectOutput,
  type MutationReplayOutput,
  type MutationTask,
} from "../fallow/mutation.ts";
import type { FallowInvocation } from "../fallow/run.ts";
import type { BuiltEvidence } from "../kinds/adapter.ts";
import type { MutationEvidenceState, MutationWitness } from "../policy/mutation.ts";
import { gitHead, readContainedBytes, writeAtomic } from "../util/files.ts";
import { canonicalJson, sha256 } from "../util/hash.ts";
import { estimateTokens } from "../util/tokens.ts";
import { functionWindow } from "./function-window.ts";
import { numberLines } from "./windows.ts";

const MUTANT_PACKET_VERSION = "mutation-mutant/v1";

/** The longest function that the packet holds. A longer function is cut, so a person reviews it. */
const MAX_FUNCTION_LINES = 400;

/** Lines around each line of a test file that names the function. */
const TEST_RADIUS = 6;

/** The token budget of the test excerpts. Test excerpts past it are left out, not cut. */
const TEST_TOKEN_BUDGET = 6_000;

/** At most this many declarations of names that the changed code reads. */
const MAX_DECLARATIONS = 8;

const NOT_DECLARATIONS: ReadonlySet<string> = new Set([
  "this",
  "true",
  "false",
  "null",
  "undefined",
  "typeof",
  "instanceof",
  "new",
  "void",
  "in",
  "of",
]);

type Excerpt = { path: string; start_line: number; end_line: number; text: string };

/**
 * The engine state for one mutant. It holds only what Fallow reported and the project files
 * that Fallow named. It never holds a replay argument value: the arguments can come from a
 * recording of real calls.
 */
export type MutantPacket = {
  schema: typeof MUTANT_PACKET_VERSION;
  mutant: {
    mutant_id: string;
    file: string;
    line: number;
    column: number;
    operator: string;
    function: string | null;
    change: { from: string; to: string } | null;
    /** The original text of the span and the text that replaces it. Null for a stale packet. */
    original: string | null;
    replacement: string | null;
    original_lines: string | null;
    mutated_lines: string | null;
    /** Fallow's advisory hint that the mutant may be equivalent. Fallow documents wrong hints. */
    equivalence_hint: string | null;
  };
  /** The enclosing function with line numbers, or null when the packet is stale. */
  function_source: Excerpt | null;
  /** Same-file declarations of the names that the changed code reads. */
  declarations: Excerpt[];
  tests: {
    /** The test ids that ran the mutant. Each of them passed on it. */
    covering: string[];
    files: string[];
    /** The parts of the test files that name the function. */
    excerpts: Excerpt[];
    /** Test excerpts left out because of the token budget. */
    omitted: number;
  };
  /** The replay result, without argument values. Null when replay is off or failed. */
  replay: {
    verdict: string;
    reason: string | null;
    export: string | null;
    inputs_checked: number;
  } | null;
  /** Why the evidence is stale or incomplete, or an empty list. */
  omissions: string[];
};

export type BuiltMutant = BuiltEvidence & {
  packet: MutantPacket;
  mutantId: string;
  evidence: MutationEvidenceState;
};

const splitLines = (text: string): string[] => text.split(/\r?\n/);

const excerpt = (file: string, lines: readonly string[], start: number, end: number): Excerpt => ({
  path: file,
  start_line: start,
  end_line: end,
  text: numberLines(lines.slice(start - 1, end), start),
});

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * True when the function binds `name` itself: in its first line, which holds the parameters in
 * most code, or in a declaration inside the window. A top-level declaration of that name is
 * then a different binding, so the packet must not show it.
 */
const bindsLocally = (window: readonly string[], name: string): boolean => {
  const escaped = escapeRegex(name);
  const word = new RegExp(`\\b${escaped}\\b`);
  // The parameters: the first line up to the arrow or the body brace.
  const head = (window[0] ?? "").split(/=>|\{/)[0] ?? "";
  const local = new RegExp(
    `\\b(?:(?:const|let|var)\\s+(?:(?!\\b(?:of|in)\\b)[^=;])*|function\\s+|class\\s+|catch\\s*\\([^)]*)\\b${escaped}\\b`,
  );
  return word.test(head) || window.some((text) => local.test(text));
};

/** Same-file declarations of the identifiers in the changed span, outside the function. */
const declarationsOf = (
  file: string,
  lines: readonly string[],
  span: string,
  inside: { start: number; end: number },
  functionName: string | null,
): Excerpt[] => {
  const window = lines.slice(inside.start - 1, inside.end);
  const names = [...new Set(span.match(/[A-Za-z_$][\w$]*/g) ?? [])].filter(
    (name) => !NOT_DECLARATIONS.has(name) && name !== functionName && !bindsLocally(window, name),
  );
  const found: Excerpt[] = [];
  for (const name of names) {
    const pattern = new RegExp(
      `\\b(?:const|let|var|function|class|interface|type|enum)\\s+${escapeRegex(name)}\\b`,
    );
    const index = lines.findIndex(
      (text, at) => (at + 1 < inside.start || at + 1 > inside.end) && pattern.test(text),
    );
    if (index !== -1) found.push(excerpt(file, lines, index + 1, index + 1));
    if (found.length >= MAX_DECLARATIONS) break;
  }
  return found;
};

type Span = { start: number; end: number };

const mergeSpans = (spans: readonly Span[]): Span[] => {
  const merged: Span[] = [];
  for (const span of spans.toSorted((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last !== undefined && span.start <= last.end + 1) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
};

/** The parts of the covering test files that name the function, up to the token budget. */
const testExcerpts = async (
  root: string,
  files: readonly string[],
  functionName: string | null,
): Promise<{ excerpts: Excerpt[]; omitted: number; digests: Record<string, string> }> => {
  const excerpts: Excerpt[] = [];
  const digests: Record<string, string> = {};
  let omitted = 0;
  let tokens = 0;
  const pattern = functionName === null ? null : new RegExp(`\\b${escapeRegex(functionName)}\\b`);
  for (const file of [...files].toSorted()) {
    const content = await readContainedBytes(root, file);
    digests[file] = content === null ? "missing" : sha256(content);
    if (content === null || pattern === null) continue;
    const lines = splitLines(content.toString("utf8"));
    const spans = lines.flatMap((text, index) =>
      pattern.test(text)
        ? [
            {
              start: Math.max(1, index + 1 - TEST_RADIUS),
              end: Math.min(lines.length, index + 1 + TEST_RADIUS),
            },
          ]
        : [],
    );
    for (const span of mergeSpans(spans)) {
      const next = excerpt(file, lines, span.start, span.end);
      const cost = estimateTokens(next.text);
      if (tokens + cost > TEST_TOKEN_BUDGET) {
        omitted += 1;
        continue;
      }
      tokens += cost;
      excerpts.push(next);
    }
  }
  return { excerpts, omitted, digests };
};

/** A replay `witness` with its input and the first result of each side. */
const replayWitness = (replay: MutationReplayOutput | null | undefined): MutationWitness | null => {
  if (replay?.verdict !== "witness") return null;
  const first = (side: "original" | "mutant") => {
    const call = replay.calls.find((entry) => entry.side === side);
    return call === undefined ? null : { outcome: call.outcome, text: call.text };
  };
  return {
    source: "replay",
    input: replay.input.args,
    original: first("original"),
    mutant: first("mutant"),
  };
};

/** The witness that a `--record-args values` run saved for the task, if any. */
const taskWitness = (task: MutationTask): MutationWitness | null => {
  const witness = task.witness;
  if (witness?.verdict !== "witness" || task.stale_reason != null) return null;
  const side = (value: typeof witness.original) =>
    value == null ? null : { outcome: value.outcome, text: value.text };
  return {
    source: "run",
    input: witness.args ?? null,
    original: side(witness.original),
    mutant: side(witness.mutant),
  };
};

const NO_CODE = { original: null, replacement: null, original_lines: null, mutated_lines: null };

/** The mutant fields of the packet. A stale packet has no code. */
const mutantOf = (
  task: MutationTask,
  inspect: MutationInspectOutput | null,
): MutantPacket["mutant"] => ({
  mutant_id: task.mutant_id,
  file: task.file,
  line: task.line,
  column: task.column,
  operator: task.operator,
  function: task.function ?? null,
  change: inspect?.change ?? null,
  ...(inspect?.code ?? NO_CODE),
  equivalence_hint: task.equivalence_hint ?? null,
});

/** The inputs of `mutantFromInspect`: Fallow output and the files that it names. */
export type MutantSources = {
  task: MutationTask;
  /** Plain inspect output, or null when inspect failed. */
  inspect: MutationInspectOutput | null;
  /** Why inspect failed. */
  failure: string | null;
  /** The replay output, or null when replay is off. */
  replay: MutationReplayOutput | null;
  /** Why the replay gave no output, for example `FALLOW_MUTATION_REPLAY_UNSUPPORTED`. */
  replayFailure: string | null;
  /** The current content of the mutated file, or null when it is unreadable. */
  source: Buffer | null;
  tests: { excerpts: Excerpt[]; omitted: number; digests: Record<string, string> };
};

/** Why the evidence is stale, or null for fresh evidence of the current file. */
const staleReason = (sources: MutantSources): string | null => {
  const { inspect, source } = sources;
  if (inspect === null) return `inspect failed (${sources.failure ?? "unknown"})`;
  if (inspect.status === "stale") return `stale (${inspect.stale_reason ?? "unknown"})`;
  // A recheck after the scan can kill the mutant without a change to its file.
  if (inspect.report_status != null && inspect.report_status !== "survived")
    return `stale (report status ${inspect.report_status})`;
  if (source === null) return "source unreadable";
  return sha256(source) === inspect.current_sha256 ? null : "stale (source-changed)";
};

type CodeEvidence = {
  functionSource: Excerpt | null;
  declarations: Excerpt[];
  /** Why the function evidence is incomplete, or null. */
  cut: string | null;
};

/** The enclosing function and the declarations that the change reads, from fresh evidence. */
const codeEvidence = (
  task: MutationTask,
  inspect: MutationInspectOutput,
  source: Buffer,
): CodeEvidence => {
  if (inspect.function_line == null)
    return { functionSource: null, declarations: [], cut: "no enclosing function" };
  const lines = splitLines(source.toString("utf8"));
  const range = functionWindow(lines, inspect.function_line, inspect.line, MAX_FUNCTION_LINES);
  return {
    functionSource: excerpt(task.file, lines, range.start, range.end),
    declarations: declarationsOf(
      task.file,
      lines,
      inspect.code?.original ?? "",
      range,
      task.function ?? null,
    ),
    cut: range.cut ? "function source window cut" : null,
  };
};

const replaySummary = (replay: MutationReplayOutput | null): MutantPacket["replay"] =>
  replay === null
    ? null
    : {
        verdict: replay.verdict,
        reason: replay.reason ?? null,
        export: replay.export ?? null,
        inputs_checked: replay.inputs_checked,
      };

const STALE_CODE: CodeEvidence = { functionSource: null, declarations: [], cut: null };

/** Builds the packet from its parts. Pure, so tests can use recorded Fallow output. */
export const mutantFromInspect = (sources: MutantSources): BuiltMutant => {
  const { task, inspect, source } = sources;
  const stale = staleReason(sources);
  const fresh = stale === null && inspect !== null && source !== null;
  const code = fresh ? codeEvidence(task, inspect, source) : STALE_CODE;
  const omissions = [stale, code.cut].filter((entry) => entry !== null);
  if (sources.replayFailure !== null)
    omissions.push(`replay unavailable (${sources.replayFailure})`);
  const packet: MutantPacket = {
    schema: MUTANT_PACKET_VERSION,
    mutant: mutantOf(task, fresh ? inspect : null),
    function_source: code.functionSource,
    declarations: code.declarations,
    tests: {
      covering: fresh ? inspect.covering_tests : [],
      files: [...task.covering_test_files],
      excerpts: fresh ? sources.tests.excerpts : [],
      omitted: fresh ? sources.tests.omitted : 0,
    },
    replay: fresh ? replaySummary(sources.replay) : null,
    omissions,
  };
  const witness = fresh ? (replayWitness(sources.replay) ?? taskWitness(task)) : null;
  const evidence: MutationEvidenceState = { stale: !fresh, truncated: code.cut !== null, witness };
  // The witness input stays out of the engine packet, but a new input is new evidence.
  const fingerprinted = { packet, witness, tests: sources.tests.digests };
  return {
    fingerprint: sha256(canonicalJson(fingerprinted)).slice(0, 32),
    stateTokens: estimateTokens(packet),
    packet,
    truncated: !fresh || code.cut !== null,
    mutantId: task.mutant_id,
    evidence,
  };
};

type ReplayResult = Pick<MutantSources, "replay" | "replayFailure">;

/** A cached replay: the replay output, or the Fallow error code of a replay that failed. */
type ReplayEntry = { key: string } & ReplayResult;

const readReplay = async (file: string, key: string): Promise<ReplayResult | null> => {
  try {
    const entry = JSON.parse(await readFile(file, "utf8")) as Partial<ReplayEntry>;
    if (entry.key !== key || entry.replay === undefined || entry.replayFailure === undefined)
      return null;
    return { replay: entry.replay, replayFailure: entry.replayFailure };
  } catch {
    return null;
  }
};

export type MutantBuildOptions = {
  /** Run `--replay` for a fresh mutant. */
  replay: boolean;
  /** The replay cache directory under the state of the kind. */
  cacheDir: string;
  /** Read the cache, but never write it. */
  readOnly: boolean;
};

/** The replay of a fresh mutant, from the cache or from a new `--replay` run. */
const replayFor = async (
  task: MutationTask,
  inspect: MutationInspectOutput,
  invocation: FallowInvocation,
  options: MutantBuildOptions,
): Promise<ReplayResult> => {
  const head = await gitHead(invocation.root);
  const key = sha256(
    canonicalJson([task.mutant_id, inspect.report_sha256, inspect.current_sha256, head]),
  );
  const file = path.join(options.cacheDir, `${key.slice(0, 32)}.json`);
  const cached = await readReplay(file, key);
  if (cached !== null) return cached;
  const replayed = await runMutationInspect({
    ...invocation,
    mutantId: task.mutant_id,
    replay: true,
  });
  const result: ReplayResult = replayed.ok
    ? replayed.data.replay == null
      ? { replay: null, replayFailure: "no replay output" }
      : { replay: replayed.data.replay, replayFailure: null }
    : { replay: null, replayFailure: replayed.fallowCode ?? replayed.error.code };
  // A Fallow error code is a stable answer for this key, for example a runner without replay
  // support. A failure without one, such as a timeout, is tried again on the next build.
  const stable = replayed.ok || replayed.fallowCode !== null;
  if (stable && !options.readOnly) await writeAtomic(file, JSON.stringify({ key, ...result }));
  return result;
};

/**
 * Builds the packet for one mutant. Plain inspect reads files only, so it runs on each build. A
 * replay runs project code and takes seconds, so its result is cached. A cache entry holds while
 * the mutant id, the digest of the mutated file in the report and now, and the Git commit stay
 * the same. An uncommitted change to a module that the file imports is not covered.
 */
export const buildMutantPacket = async (
  task: MutationTask,
  invocation: FallowInvocation,
  options: MutantBuildOptions,
): Promise<BuiltMutant> => {
  const source = await readContainedBytes(invocation.root, task.file);
  const tests = await testExcerpts(
    invocation.root,
    task.covering_test_files,
    task.function ?? null,
  );
  const plain = await runMutationInspect({
    ...invocation,
    mutantId: task.mutant_id,
    replay: false,
  });
  const base = { task, source, tests, replay: null, replayFailure: null };
  // The message can hold a temporary path, so only the stable code enters the fingerprint.
  if (!plain.ok)
    return mutantFromInspect({
      ...base,
      inspect: null,
      failure: plain.fallowCode ?? plain.error.code,
    });
  const inspect = plain.data;
  const fresh =
    inspect.status === "fresh" && source !== null && sha256(source) === inspect.current_sha256;
  if (!options.replay || !fresh) return mutantFromInspect({ ...base, inspect, failure: null });

  return mutantFromInspect({
    ...base,
    inspect,
    failure: null,
    ...(await replayFor(task, inspect, invocation, options)),
  });
};
