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
  options: {
    project: { type: "string" },
    scope: { type: "string" },
    tarball: { type: "string" },
    published: { type: "string" },
  },
});
assert.ok(
  values.tarball === undefined || values.published === undefined,
  "Use either --tarball or --published, not both.",
);
const exactVersion = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
    "--published requires an exact semantic version, such as 0.1.0.",
  );
if (values.published !== undefined) exactVersion.parse(values.published);
if (values.tarball !== undefined) assert.ok(values.tarball.length > 0, "--tarball needs a path.");
const project = path.resolve(values.project ?? path.join(repository, "eval/corpus"));
const scope = values.scope ?? "src";
const npmCli = process.env.npm_execpath;
if (npmCli === undefined) throw new Error("Run this check with npm run verify:package.");
const scratch = await mkdtemp(path.join(tmpdir(), "fallow-verdict-package-"));
const consumer = path.join(scratch, "consumer");
const COMMAND_TIMEOUT_MS = 120_000;
const SMOKE_KEY_ENV = "FALLOW_VERDICT_PACKAGE_SMOKE_KEY";
const PUBLIC_REGISTRY = "https://registry.npmjs.org/";
// Smoke checks are public consumers. Do not inherit release or provider credentials.
const environment: NodeJS.ProcessEnv = {};
for (const key of [
  "PATH",
  "HOME",
  "USERPROFILE",
  "SystemRoot",
  "WINDIR",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "CI",
  "NO_COLOR",
]) {
  if (process.env[key] !== undefined) environment[key] = process.env[key];
}
environment.NPM_CONFIG_USERCONFIG = path.join(scratch, "npmrc");
environment.NPM_CONFIG_GLOBALCONFIG = path.join(scratch, "global-npmrc");
environment.NPM_CONFIG_REGISTRY = PUBLIC_REGISTRY;
environment[SMOKE_KEY_ENV] = "";
const run = (args: string[], cwd = consumer, executable = process.execPath): string =>
  execFileSync(executable, args, {
    cwd,
    encoding: "utf8",
    timeout: COMMAND_TIMEOUT_MS,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

try {
  await mkdir(consumer);
  await writeFile(path.join(scratch, "npmrc"), "");
  await writeFile(path.join(scratch, "global-npmrc"), "");
  await writeFile(
    path.join(consumer, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  const manifest = z
    .object({ name: z.literal("fallow-verdict"), version: exactVersion })
    .parse(JSON.parse(await readFile(path.join(repository, "package.json"), "utf8")));
  const lock = z
    .object({
      packages: z.object({ "node_modules/fallow": z.object({ version: exactVersion }) }),
    })
    .parse(JSON.parse(await readFile(path.join(repository, "package-lock.json"), "utf8")));
  const expectedVersion = values.published ?? manifest.version;
  let packageSource: string;
  if (values.published !== undefined) {
    packageSource = `fallow-verdict@${values.published}`;
  } else if (values.tarball !== undefined) {
    packageSource = path.resolve(values.tarball);
  } else {
    run([npmCli, "pack", "--pack-destination", scratch], repository);
    const tarballs = (await readdir(scratch)).filter((name) => name.endsWith(".tgz"));
    assert.equal(tarballs.length, 1, "Expected one packed artifact.");
    packageSource = path.join(scratch, z.string().parse(tarballs[0]));
  }
  run([
    npmCli,
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--registry",
    PUBLIC_REGISTRY,
    packageSource,
    `fallow@${lock.packages["node_modules/fallow"].version}`,
  ]);
  const cli = path.join(consumer, "node_modules/fallow-verdict/bin/fallow-verdict.js");
  const installed = z
    .object({ name: z.literal("fallow-verdict"), version: exactVersion })
    .parse(
      JSON.parse(
        await readFile(path.join(consumer, "node_modules/fallow-verdict/package.json"), "utf8"),
      ),
    );
  assert.equal(
    installed.version,
    expectedVersion,
    "Installed package version differs from the release.",
  );
  assert.equal(run([cli, "--version"]), expectedVersion);
  run([cli, "init"]);
  assert.match(await readFile(path.join(consumer, ".gitignore"), "utf8"), /\.fallow-verdict\//);
  run(["--input-type=module", "-e", 'await import("./fallow-verdict.config.ts");']);
  // Verify the installed binary through Fallow's launcher before using it directly on Windows.
  run([path.join(consumer, "node_modules/fallow/bin/fallow"), "--version"]);
  const fallowBinary =
    process.platform === "win32"
      ? run([
          "--input-type=commonjs",
          "-e",
          `
const path = require("node:path");
const fallowRequire = require("node:module").createRequire(require.resolve("fallow/package.json"));
const { getPlatformPackage } = fallowRequire("./scripts/platform-package.js");
const platformPackage = getPlatformPackage(process.platform, process.arch);
if (platformPackage === null) throw new Error("Unsupported Fallow platform");
process.stdout.write(path.join(path.dirname(fallowRequire.resolve(platformPackage + "/package.json")), "fallow.exe"));
`,
        ])
      : path.join(consumer, "node_modules/.bin/fallow");
  const state = path.join(scratch, "state");
  const config = path.join(scratch, "config.json");
  await writeFile(
    config,
    JSON.stringify({
      root: project,
      dataDir: state,
      fallow: { binary: fallowBinary },
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
    `Package ${installed.version}: CLI, init, public imports and scan/dry-run contract passed. No engine requests.\n`,
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}
