import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  SimilarCodeCandidate,
  SimilarCodeInspectOutput,
  SimilarCodeOutput,
  SimilarCodeReviewOutput,
  SimilarCodeVerdict,
} from "fallow/types";

import { verdictError, type VerdictError } from "../util/errors.ts";
import { err, ok, type Result } from "../util/result.ts";
import { capture, parseJson, resolveFallowBinary, type FallowInvocation } from "./run.ts";

export type {
  SimilarCodeCandidate,
  SimilarCodeInspectOutput,
  SimilarCodeOutput,
  SimilarCodeReviewOutput,
  SimilarCodeVerdict,
};

/** `fallow similar-code` schema versions this release was verified against. */
export const SUPPORTED_SIMILAR_CODE_SCHEMA_VERSIONS: readonly string[] = ["1"];

/** The verdict document version that `fallow similar-code review` accepts. */
export const SIMILAR_CODE_VERDICT_SCHEMA = "1";

/** The input document of `fallow similar-code review --verdicts`. */
export type SimilarCodeVerdictInput = {
  schema_version: typeof SIMILAR_CODE_VERDICT_SCHEMA;
  verdicts: SimilarCodeVerdict[];
};

/** A cold run embeds every admitted function, so discovery gets a longer default window. */
const DISCOVERY_TIMEOUT_MS = 900_000;
const DEFAULT_TIMEOUT_MS = 300_000;

const SETUP_HINT =
  "A person must run `fallow similar-code setup --local` first. fallow-verdict never downloads the model.";

export type SimilarCodeScanOptions = FallowInvocation & {
  changedSince?: string | undefined;
  paths?: readonly string[] | undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The message of a Fallow JSON error on stdout, else stderr, else the start of stdout. */
const failureDetail = (stdout: string, stderr: string): string => {
  const parsed = parseJson(stdout);
  if (parsed.ok && isRecord(parsed.data) && typeof parsed.data["message"] === "string")
    return parsed.data["message"];
  return stderr.trim() || stdout.trim().slice(0, 400);
};

const isLocation = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value["path"] === "string" &&
  value["path"].length > 0 &&
  typeof value["name"] === "string" &&
  typeof value["start_line"] === "number" &&
  typeof value["start_column"] === "number" &&
  typeof value["source_sha256"] === "string";

/** Validate the envelope and the candidate identities; other fields follow Fallow's contract. */
export const parseSimilarCodeOutput = (value: unknown): Result<SimilarCodeOutput, VerdictError> => {
  if (!isRecord(value) || !Array.isArray(value["candidates"]) || !isRecord(value["completion"]))
    return err(
      verdictError(
        "fallow_output_invalid",
        "Expected `fallow similar-code --format json` output with `candidates` and `completion`.",
      ),
    );
  const version = String(value["schema_version"]);
  if (!SUPPORTED_SIMILAR_CODE_SCHEMA_VERSIONS.includes(version))
    return err(
      verdictError(
        "fallow_schema_unsupported",
        `fallow similar-code schema_version ${version} is not supported (supported: ${SUPPORTED_SIMILAR_CODE_SCHEMA_VERSIONS.join(", ")}).`,
        "Upgrade fallow-verdict, or pin a fallow version it supports.",
      ),
    );
  const seen = new Set<string>();
  for (const candidate of value["candidates"]) {
    if (
      !isRecord(candidate) ||
      typeof candidate["candidate_id"] !== "string" ||
      candidate["candidate_id"].trim().length === 0 ||
      typeof candidate["review_key"] !== "string" ||
      !isLocation(candidate["left"]) ||
      !isLocation(candidate["right"])
    )
      return err(
        verdictError(
          "fallow_output_invalid",
          "Each similar-code candidate needs a candidate_id, a review_key and two locations.",
        ),
      );
    if (seen.has(candidate["candidate_id"]))
      return err(
        verdictError(
          "fallow_output_invalid",
          "Fallow returned duplicate candidate IDs. Separate candidates cannot share a verdict record.",
          "Update fallow and rerun the scan.",
        ),
      );
    seen.add(candidate["candidate_id"]);
  }
  return ok(value as unknown as SimilarCodeOutput);
};

/** Only a complete discovery makes the absence of a candidate conclusive. */
export const isCompleteDiscovery = (output: SimilarCodeOutput): boolean =>
  output.completion.status === "complete";

const isFile = async (file: string): Promise<boolean> => {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
};

const inside = (root: string, scope: string, file: string): boolean => {
  const relative = path.relative(path.resolve(root, scope), path.resolve(root, file));
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
};

/**
 * Runs discovery. A file scope goes to Fallow as `--file`, so Fallow ranks those functions
 * first. A directory scope runs for the project and keeps the pairs with a side in the scope.
 */
export const runSimilarCodeScan = async (
  options: SimilarCodeScanOptions,
): Promise<Result<SimilarCodeOutput, VerdictError>> => {
  const binary = resolveFallowBinary(options.root, options.binary);
  const paths = options.paths ?? [];
  const files: string[] = [];
  for (const scope of paths)
    if (await isFile(path.resolve(options.root, scope)))
      files.push(path.relative(options.root, path.resolve(options.root, scope)));
  const directories = paths.length > 0 && files.length < paths.length;
  const args = ["similar-code", "--format", "json", "--quiet"];
  if (options.changedSince !== undefined) args.push("--changed-since", options.changedSince);
  if (!directories) for (const file of files) args.push("--file", file.split(path.sep).join("/"));

  const captured = await capture(
    binary,
    args,
    options.root,
    options.timeoutMs ?? DISCOVERY_TIMEOUT_MS,
    options.signal,
  );
  if (!captured.ok) return captured;
  if (captured.data.code !== 0) {
    const detail = failureDetail(captured.data.stdout, captured.data.stderr);
    return err(
      verdictError(
        "fallow_failed",
        `fallow similar-code exited with ${captured.data.code}: ${detail}`,
        /setup|not ready|model/i.test(detail) ? SETUP_HINT : undefined,
      ),
    );
  }
  const parsed = parseJson(captured.data.stdout);
  if (!parsed.ok) return parsed;
  const output = parseSimilarCodeOutput(parsed.data);
  if (!output.ok || !directories) return output;
  return ok({
    ...output.data,
    candidates: output.data.candidates.filter((candidate) =>
      paths.some(
        (scope) =>
          inside(options.root, scope, candidate.left.path) ||
          inside(options.root, scope, candidate.right.path),
      ),
    ),
  });
};

/** Writes a discovery document to a private temporary file for one Fallow call. */
const withSnapshot = async <T>(
  output: SimilarCodeOutput,
  use: (file: string) => Promise<T>,
): Promise<T> => {
  const dir = await mkdtemp(path.join(tmpdir(), "fallow-verdict-similar-code-"));
  const file = path.join(dir, "candidates.json");
  try {
    await writeFile(file, JSON.stringify(output), { mode: 0o600 });
    return await use(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/**
 * Runs `fallow similar-code inspect` against the unchanged discovery document. Inspect fails
 * closed when a side changed after discovery, so an error here is normal after an edit.
 */
export const runSimilarCodeInspect = async (
  options: FallowInvocation & { candidateId: string; output: SimilarCodeOutput },
): Promise<Result<SimilarCodeInspectOutput, VerdictError>> => {
  const binary = resolveFallowBinary(options.root, options.binary);
  const captured = await withSnapshot(options.output, (file) =>
    capture(
      binary,
      [
        "similar-code",
        "inspect",
        options.candidateId,
        "--candidates",
        file,
        "--format",
        "json",
        "--quiet",
      ],
      options.root,
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      options.signal,
    ),
  );
  if (!captured.ok) return captured;
  if (captured.data.code !== 0)
    return err(
      verdictError(
        "fallow_failed",
        `fallow similar-code inspect failed: ${failureDetail(captured.data.stdout, captured.data.stderr)}`,
      ),
    );
  const parsed = parseJson(captured.data.stdout);
  if (!parsed.ok) return parsed;
  const value = parsed.data;
  if (
    !isRecord(value) ||
    !isRecord(value["packet"]) ||
    value["packet"]["candidate_id"] !== options.candidateId
  )
    return err(
      verdictError(
        "fallow_output_invalid",
        "fallow similar-code inspect did not return a packet for the requested candidate.",
      ),
    );
  return ok(value as unknown as SimilarCodeInspectOutput);
};

/** Lets Fallow join the verdict document with the unchanged discovery document. */
export const runSimilarCodeReview = async (
  options: FallowInvocation & {
    candidatesPath: string;
    verdictsPath: string;
    /** Pass `--require-verdict-for-each-candidate`. */
    requireEach: boolean;
  },
): Promise<Result<SimilarCodeReviewOutput, VerdictError>> => {
  const binary = resolveFallowBinary(options.root, options.binary);
  const captured = await capture(
    binary,
    [
      "similar-code",
      "review",
      "--candidates",
      options.candidatesPath,
      "--verdicts",
      options.verdictsPath,
      ...(options.requireEach ? ["--require-verdict-for-each-candidate"] : []),
      "--format",
      "json",
      "--quiet",
    ],
    options.root,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    options.signal,
  );
  if (!captured.ok) return captured;
  if (captured.data.code !== 0)
    return err(
      verdictError(
        "fallow_failed",
        `fallow similar-code review rejected the verdicts: ${failureDetail(captured.data.stdout, captured.data.stderr)}`,
      ),
    );
  const parsed = parseJson(captured.data.stdout);
  if (!parsed.ok) return parsed;
  if (!isRecord(parsed.data) || !Array.isArray(parsed.data["candidates"]))
    return err(
      verdictError(
        "fallow_output_invalid",
        "fallow similar-code review did not return a `candidates` array.",
      ),
    );
  return ok(parsed.data as unknown as SimilarCodeReviewOutput);
};
