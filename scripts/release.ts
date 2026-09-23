import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { z } from "zod";

import {
  artifactHashes,
  checkReleaseMetadata,
  parseRelease,
  readRelease,
  verifyPublicRelease,
} from "./release-lib.ts";

const repository = fileURLToPath(new URL("../", import.meta.url));
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    tag: { type: "string" },
    directory: { type: "string" },
    "wait-seconds": { type: "string" },
    "require-latest": { type: "boolean" },
  },
});

const run = async (): Promise<void> => {
  const command = positionals[0];
  if (positionals.length !== 1 || !["check", "pack", "verify-public"].includes(command ?? "")) {
    throw new Error("Usage: release.ts check|pack|verify-public [options]");
  }
  if (command === "verify-public") {
    if (!values.directory) throw new Error("--directory is required.");
    const release = await readRelease(path.resolve(values.directory));
    await verifyPublicRelease(release, {
      waitSeconds: Number(values["wait-seconds"] ?? "0"),
      requireLatest: values["require-latest"] ?? false,
    });
    process.stdout.write(
      `${release.name}@${release.version}: public bytes match the prepared artifact.\n`,
    );
    return;
  }
  if (!values.tag) throw new Error("--tag is required.");
  const version = await checkReleaseMetadata(repository, values.tag);
  if (command === "check") {
    process.stdout.write(`Release metadata for ${values.tag} passed.\n`);
    return;
  }
  if (!values.directory || !path.isAbsolute(values.directory))
    throw new Error("--directory must be absolute.");
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("Run packing with npm run release:pack.");
  await mkdir(values.directory, { recursive: true });
  if ((await readdir(values.directory)).length !== 0)
    throw new Error("Artifact directory must be empty.");
  const output = execFileSync(
    process.execPath,
    [npmCli, "pack", "--ignore-scripts", "--json", "--pack-destination", values.directory],
    {
      cwd: repository,
      encoding: "utf8",
      timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const [packed] = z
    .array(
      z.object({
        name: z.literal("fallow-verdict"),
        version: z.literal(version),
        filename: z.literal(`fallow-verdict-${version}.tgz`),
        integrity: z.string(),
      }),
    )
    .length(1)
    .parse(JSON.parse(output));
  if (!packed) throw new Error("npm pack did not return an artifact.");
  const hashes = artifactHashes(await readFile(path.join(values.directory, packed.filename)));
  if (hashes.integrity !== packed.integrity) throw new Error("npm pack integrity mismatch.");
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repository,
    encoding: "utf8",
  }).trim();
  const release = parseRelease({
    name: packed.name,
    version,
    tag: values.tag,
    commit,
    file: packed.filename,
    ...hashes,
  });
  await writeFile(
    path.join(values.directory, "release.json"),
    `${JSON.stringify(release, null, 2)}\n`,
  );
  await writeFile(
    path.join(values.directory, "SHA256SUMS"),
    `${release.sha256}  ${release.file}\n`,
  );
  process.stdout.write(`Prepared ${release.file} (${release.sha256}).\n`);
};

await run().catch((error: unknown): void => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Release verification failed."}\n`,
  );
  process.exitCode = 1;
});
