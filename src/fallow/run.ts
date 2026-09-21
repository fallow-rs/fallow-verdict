import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { err, ok, type Result } from "../util/result.ts";
import { verdictError, type VerdictError } from "../util/errors.ts";
import { SUPPORTED_SECURITY_SCHEMA_VERSIONS, type SecurityOutput } from "./types.ts";

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 300_000;
/** `fallow security` exits 1 on advisory findings and 8 on a gate failure; both still carry JSON. */
const EXIT_CODES_WITH_OUTPUT: ReadonlySet<number> = new Set([0, 1, 8]);

export type FallowInvocation = {
  root: string;
  /** Explicit binary path; resolved from the project or PATH when omitted. */
  binary?: string | undefined;
  timeoutMs?: number | undefined;
};

export type SecurityScanOptions = FallowInvocation & {
  changedSince?: string | undefined;
  workspace?: string | undefined;
  paths?: readonly string[] | undefined;
};

type Captured = { code: number; stdout: string; stderr: string };

/** Prefer the project's own fallow so the scan matches what CI runs. */
export const resolveFallowBinary = (root: string, explicit?: string): string => {
  if (explicit !== undefined) return explicit;
  const local = path.join(root, "node_modules", ".bin", "fallow");
  if (existsSync(local)) return local;
  try {
    const require = createRequire(path.join(root, "package.json"));
    const manifest = require.resolve("fallow/package.json");
    return path.join(path.dirname(manifest), "bin", "fallow");
  } catch {
    return "fallow";
  }
};

const capture = (
  binary: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<Result<Captured, VerdictError>> =>
  new Promise((resolve) => {
    const child = spawn(binary, [...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: { stdout: string[]; stderr: string[] } = { stdout: [], stderr: [] };
    let bytes = 0;
    let settled = false;

    const settle = (result: Result<Captured, VerdictError>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill();
      settle(err(verdictError("fallow_failed", `fallow timed out after ${timeoutMs} ms.`)));
    }, timeoutMs);

    const collect =
      (stream: "stdout" | "stderr") =>
      (chunk: string): void => {
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT_BYTES) {
          child.kill();
          settle(err(verdictError("fallow_failed", "fallow output exceeded the size limit.")));
          return;
        }
        chunks[stream].push(chunk);
      };

    child.stdout.setEncoding("utf8").on("data", collect("stdout"));
    child.stderr.setEncoding("utf8").on("data", collect("stderr"));
    child.on("error", (cause) => {
      const missing = (cause as NodeJS.ErrnoException).code === "ENOENT";
      settle(
        err(
          missing
            ? verdictError(
                "fallow_not_found",
                `Could not run \`${binary}\`.`,
                "Install fallow (`npm i -D fallow`) or set `fallow.binary` in the config.",
              )
            : verdictError("fallow_failed", cause.message),
        ),
      );
    });
    child.on("close", (code, signal) => {
      if (signal !== null) {
        settle(err(verdictError("fallow_failed", `fallow was terminated by ${signal}.`)));
        return;
      }
      settle(
        ok({ code: code ?? 2, stdout: chunks.stdout.join(""), stderr: chunks.stderr.join("") }),
      );
    });
  });

const parseJson = (text: string): Result<unknown, VerdictError> => {
  try {
    return ok(JSON.parse(text) as unknown);
  } catch {
    return err(verdictError("fallow_output_invalid", "fallow did not print valid JSON."));
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Validates the envelope only; the finding shape is fallow's contract and is trusted. */
export const parseSecurityOutput = (value: unknown): Result<SecurityOutput, VerdictError> => {
  if (!isRecord(value) || !Array.isArray(value["security_findings"])) {
    return err(
      verdictError(
        "fallow_output_invalid",
        "Expected `fallow security --format json` output with a `security_findings` array.",
      ),
    );
  }
  const version = String(value["schema_version"]);
  if (!SUPPORTED_SECURITY_SCHEMA_VERSIONS.includes(version)) {
    return err(
      verdictError(
        "fallow_schema_unsupported",
        `fallow security schema_version ${version} is not supported (supported: ${SUPPORTED_SECURITY_SCHEMA_VERSIONS.join(", ")}).`,
        "Upgrade fallow-verdict, or pin a fallow version it supports.",
      ),
    );
  }
  return ok(value as unknown as SecurityOutput);
};

export const runSecurityScan = async (
  options: SecurityScanOptions,
): Promise<Result<SecurityOutput, VerdictError>> => {
  const binary = resolveFallowBinary(options.root, options.binary);
  const args = ["security", "--format", "json", "--surface", "--quiet"];
  if (options.changedSince !== undefined) args.push("--changed-since", options.changedSince);
  if (options.workspace !== undefined) args.push("--workspace", options.workspace);
  args.push(...(options.paths ?? []));

  const captured = await capture(
    binary,
    args,
    options.root,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  if (!captured.ok) return captured;
  if (!EXIT_CODES_WITH_OUTPUT.has(captured.data.code)) {
    const detail = captured.data.stderr.trim() || captured.data.stdout.trim().slice(0, 400);
    return err(
      verdictError("fallow_failed", `fallow exited with ${captured.data.code}: ${detail}`),
    );
  }
  const parsed = parseJson(captured.data.stdout);
  return parsed.ok ? parseSecurityOutput(parsed.data) : parsed;
};

export type SurvivorsOptions = FallowInvocation & {
  candidatesPath: string;
  verdictsPath: string;
};

/** Lets fallow itself post-validate the verdict file against the candidate set. */
export const runSurvivors = async (
  options: SurvivorsOptions,
): Promise<Result<unknown, VerdictError>> => {
  const binary = resolveFallowBinary(options.root, options.binary);
  const args = [
    "security",
    "survivors",
    "--candidates",
    options.candidatesPath,
    "--verdicts",
    options.verdictsPath,
    "--format",
    "json",
  ];
  const captured = await capture(
    binary,
    args,
    options.root,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  if (!captured.ok) return captured;
  if (captured.data.code !== 0) {
    const detail = captured.data.stderr.trim() || captured.data.stdout.trim().slice(0, 400);
    return err(
      verdictError("fallow_failed", `fallow security survivors rejected the verdicts: ${detail}`),
    );
  }
  return parseJson(captured.data.stdout);
};
