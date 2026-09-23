import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

const PACKAGE_NAME = "fallow-verdict";
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const REGISTRY = "https://registry.npmjs.org";
const MAX_WAIT_SECONDS = 3600;
const POLL_MILLISECONDS = 20_000;
const REQUEST_TIMEOUT_MILLISECONDS = 30_000;

const releaseSchema = z
  .strictObject({
    name: z.literal(PACKAGE_NAME),
    version: z.string().regex(VERSION),
    tag: z.string(),
    commit: z.string().regex(/^[a-f0-9]{40}$/),
    file: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]{86}==$/),
  })
  .refine((release) => release.tag === `v${release.version}`, "Tag/version mismatch")
  .refine(
    (release) => release.file === `${PACKAGE_NAME}-${release.version}.tgz`,
    "Unexpected artifact filename",
  );

/** The immutable identity of one prepared release. */
export type Release = z.infer<typeof releaseSchema>;

/** Parse release metadata without accepting paths outside the artifact directory. */
export const parseRelease = (value: unknown): Release => releaseSchema.parse(value);

/** Compute the hashes used by npm and by the maintainer's stage comparison. */
export const artifactHashes = (bytes: Uint8Array): Pick<Release, "sha256" | "integrity"> => ({
  sha256: createHash("sha256").update(bytes).digest("hex"),
  integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
});

/** Require a dated changelog entry and synchronized package versions. */
export const checkReleaseMetadata = async (repository: string, tag: string): Promise<string> => {
  const version = tag.startsWith("v") ? tag.slice(1) : "";
  if (!VERSION.test(version)) throw new Error("Release tag must match vMAJOR.MINOR.PATCH.");
  const manifest = z.object({ name: z.literal(PACKAGE_NAME), version: z.literal(version) });
  manifest.parse(JSON.parse(await readFile(path.join(repository, "package.json"), "utf8")));
  z.object({
    name: z.literal(PACKAGE_NAME),
    version: z.literal(version),
    packages: z.object({ "": manifest }),
  }).parse(JSON.parse(await readFile(path.join(repository, "package-lock.json"), "utf8")));
  const changelog = await readFile(path.join(repository, "CHANGELOG.md"), "utf8");
  const escapedVersion = version.replaceAll(".", "\\.");
  const heading = new RegExp(`^## ${escapedVersion} \\((\\d{4}-\\d{2}-\\d{2})\\)$`, "gm");
  const matches = [...changelog.matchAll(heading)];
  const match = matches[0];
  if (matches.length !== 1 || match === undefined) {
    throw new Error(`Expected one dated changelog section for ${version}.`);
  }
  const date = match[1];
  if (date === undefined || new Date(date).toISOString().slice(0, 10) !== date) {
    throw new Error("Changelog release date is invalid.");
  }
  const body = changelog
    .slice(match.index + match[0].length)
    .split(/^## /m)[0]
    ?.trim();
  if (!body || !/[A-Za-z]/.test(body)) throw new Error("Changelog release section is empty.");
  if (body.includes("\u2014")) throw new Error("Changelog release section contains an em dash.");
  return version;
};

/** Read a release manifest and prove its local tarball still matches. */
export const readRelease = async (directory: string): Promise<Release> => {
  const release = parseRelease(
    JSON.parse(await readFile(path.join(directory, "release.json"), "utf8")),
  );
  const actual = artifactHashes(await readFile(path.join(directory, release.file)));
  if (actual.sha256 !== release.sha256 || actual.integrity !== release.integrity) {
    throw new Error("Prepared tarball does not match release.json.");
  }
  return release;
};

interface PublicOptions {
  fetch?: typeof fetch;
  waitSeconds?: number;
  requireLatest?: boolean;
}

class RetryableRegistryError extends Error {}

const request = async (url: string, fetcher: typeof fetch): Promise<Response> => {
  let response: Response;
  try {
    response = await fetcher(url, {
      headers: { "Cache-Control": "no-cache" },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS),
    });
  } catch {
    throw new RetryableRegistryError("Registry request failed.");
  }
  if (response.ok) return response;
  if (
    response.status === 404 ||
    response.status === 408 ||
    response.status === 429 ||
    response.status >= 500
  ) {
    throw new RetryableRegistryError(`Registry returned HTTP ${response.status}.`);
  }
  throw new Error(`Registry returned HTTP ${response.status}.`);
};

/** Verify public registry bytes against the exact prepared release, without credentials. */
export const verifyPublicRelease = async (
  input: Release,
  options: PublicOptions = {},
): Promise<void> => {
  const release = parseRelease(input);
  const waitSeconds = options.waitSeconds ?? 0;
  if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > MAX_WAIT_SECONDS) {
    throw new Error(`wait-seconds must be an integer from 0 to ${MAX_WAIT_SECONDS}.`);
  }
  const deadline = Date.now() + waitSeconds * 1000;
  const fetcher = options.fetch ?? fetch;
  while (true) {
    try {
      const response = await request(`${REGISTRY}/${PACKAGE_NAME}/${release.version}`, fetcher);
      const published = z
        .object({
          name: z.literal(PACKAGE_NAME),
          version: z.literal(release.version),
          dist: z.object({ integrity: z.string(), tarball: z.string().url() }),
        })
        .parse(await response.json());
      if (published.dist.integrity !== release.integrity)
        throw new Error("Public npm integrity differs from the prepared artifact.");
      const url = new URL(published.dist.tarball);
      if (
        url.origin !== REGISTRY ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== `/${PACKAGE_NAME}/-/${release.file}`
      ) {
        throw new Error("Unexpected public tarball URL.");
      }
      const tarball = await request(url.href, fetcher);
      const actual = artifactHashes(new Uint8Array(await tarball.arrayBuffer()));
      if (actual.sha256 !== release.sha256 || actual.integrity !== release.integrity) {
        throw new Error("Public tarball bytes differ from the prepared artifact.");
      }
      if (options.requireLatest) {
        const latest = await request(`${REGISTRY}/${PACKAGE_NAME}/latest`, fetcher);
        const manifest = z.object({ version: z.string() }).parse(await latest.json());
        if (manifest.version !== release.version)
          throw new Error("npm latest does not point to this release.");
      }
      return;
    } catch (error) {
      if (!(error instanceof RetryableRegistryError) || Date.now() >= deadline) throw error;
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(POLL_MILLISECONDS, deadline - Date.now())),
      );
    }
  }
};
