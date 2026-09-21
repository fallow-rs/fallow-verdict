import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import { err, ok, type Result } from "../util/result.ts";
import { verdictError, type VerdictError } from "../util/errors.ts";
import { configSchema, type VerdictConfig } from "./schema.ts";

const CONFIG_FILENAMES: readonly string[] = [
  "fallow-verdict.config.ts",
  "fallow-verdict.config.mjs",
  "fallow-verdict.config.js",
  "fallow-verdict.config.json",
];

export type LoadedConfig = {
  config: VerdictConfig;
  /** Absolute project root. */
  root: string;
  /** Absolute state directory. */
  dataDir: string;
  /** Null when running on defaults. */
  configPath: string | null;
};

const findConfigFile = (from: string): string | null => {
  for (let dir = from; ; dir = path.dirname(dir)) {
    for (const name of CONFIG_FILENAMES) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    if (path.dirname(dir) === dir) return null;
  }
};

const importConfig = async (file: string): Promise<Result<unknown, VerdictError>> => {
  try {
    if (file.endsWith(".json")) return ok(JSON.parse(await readFile(file, "utf8")) as unknown);
    const module = (await import(pathToFileURL(file).href)) as { default?: unknown };
    return ok(module.default);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const hint = file.endsWith(".ts")
      ? "TypeScript config files need Node 22.18 or newer. Use `.mjs` or `.json` on older versions."
      : undefined;
    return err(verdictError("config_invalid", `Could not load ${file}: ${message}`, hint));
  }
};

export const loadConfig = async (
  cwd: string,
  explicitPath?: string,
): Promise<Result<LoadedConfig, VerdictError>> => {
  const configPath = explicitPath ? path.resolve(cwd, explicitPath) : findConfigFile(cwd);
  if (explicitPath !== undefined && (configPath === null || !existsSync(configPath))) {
    return err(verdictError("config_not_found", `Config file not found: ${explicitPath}`));
  }

  let raw: unknown = {};
  if (configPath !== null) {
    const imported = await importConfig(configPath);
    if (!imported.ok) return imported;
    raw = imported.data ?? {};
  }

  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    return err(
      verdictError(
        "config_invalid",
        `Invalid config${configPath ? ` in ${configPath}` : ""}:\n${z.prettifyError(parsed.error)}`,
      ),
    );
  }

  const base = configPath ? path.dirname(configPath) : cwd;
  const root = path.resolve(base, parsed.data.root);
  return ok({
    config: parsed.data,
    root,
    dataDir: path.resolve(root, parsed.data.dataDir),
    configPath,
  });
};
