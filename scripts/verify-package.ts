import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { z } from "zod";

const repository = fileURLToPath(new URL("../", import.meta.url));
const { values } = parseArgs({
  options: { project: { type: "string" }, scope: { type: "string" } },
});
const project = path.resolve(values.project ?? path.join(repository, "eval/corpus"));
const scope = values.scope ?? "src";
const npmCli = process.env.npm_execpath;
if (npmCli === undefined) throw new Error("Run this check with npm run verify:package.");
const scratch = await mkdtemp(path.join(tmpdir(), "fallow-verdict-package-"));
const consumer = path.join(scratch, "consumer");
const COMMAND_TIMEOUT_MS = 120_000;
const SMOKE_KEY_ENV = "FALLOW_VERDICT_PACKAGE_SMOKE_KEY";
const run = (args: string[], cwd = consumer, executable = process.execPath): string =>
  execFileSync(executable, args, {
    cwd,
    encoding: "utf8",
    timeout: COMMAND_TIMEOUT_MS,
    env: { ...process.env, [SMOKE_KEY_ENV]: "" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

try {
  await mkdir(consumer);
  await writeFile(
    path.join(consumer, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  run([npmCli, "pack", "--pack-destination", scratch], repository);
  const tarballs = (await readdir(scratch)).filter((name) => name.endsWith(".tgz"));
  assert.equal(tarballs.length, 1, "Expected one packed artifact.");
  const tarball = z.string().parse(tarballs[0]);
  run([
    npmCli,
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    path.join(scratch, tarball),
  ]);
  const cli = path.join(consumer, "node_modules/fallow-verdict/bin/fallow-verdict.js");
  const manifest = z
    .object({ version: z.string() })
    .parse(JSON.parse(await readFile(path.join(repository, "package.json"), "utf8")));
  assert.equal(
    run(["--version"], consumer, path.join(consumer, "node_modules/.bin/fallow-verdict")),
    manifest.version,
  );
  const state = path.join(scratch, "state");
  const config = path.join(scratch, "config.json");
  await writeFile(
    config,
    JSON.stringify({
      root: project,
      dataDir: state,
      fallow: { binary: path.join(repository, "node_modules/.bin/fallow") },
      engine: { apiKeyEnv: SMOKE_KEY_ENV },
    }),
  );
  run([cli, "scan", scope, "--config", config, "--format", "json"]);
  z.object({ security_findings: z.array(z.unknown()).min(1) }).parse(
    JSON.parse(await readFile(path.join(state, "candidates.json"), "utf8")),
  );
  const dryRun = z.object({
    judged: z.literal(0),
    costUsd: z.literal(0),
    estimatedUsd: z.number().positive(),
  });
  dryRun.parse(
    JSON.parse(run([cli, "judge", "--dry-run", "--config", config, "--format", "json"])),
  );

  await writeFile(
    path.join(consumer, "imports.mts"),
    `
import { defineConfig, type VerdictConfigInput } from "fallow-verdict/config";
import type { DecisionEngine, EvaluateRequest, EvaluateResponse } from "fallow-verdict/engine";
const config: VerdictConfigInput = defineConfig({ questionProfile: "generic" });
const evaluate = (engine: DecisionEngine, request: EvaluateRequest): Promise<
  { ok: true; data: EvaluateResponse } | { ok: false; error: { code: string; message: string } }
> => engine.evaluate(request);
void config;
void evaluate;
`,
  );
  run([
    path.join(repository, "node_modules/typescript/bin/tsc"),
    "--strict",
    "--noEmit",
    "--target",
    "ES2023",
    "--module",
    "NodeNext",
    "--moduleResolution",
    "NodeNext",
    "imports.mts",
  ]);
  run([
    "--input-type=module",
    "-e",
    'import { defineConfig } from "fallow-verdict/config"; if (defineConfig({ root: "." }).root !== ".") throw new Error("Config import failed");',
  ]);
  process.stdout.write(
    "Packed CLI, public imports and scan/dry-run contract passed. No engine requests.\n",
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}
