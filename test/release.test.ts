import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  artifactHashes,
  checkReleaseMetadata,
  parseRelease,
  readRelease,
  verifyPublicRelease,
} from "../scripts/release-lib.ts";

const directories: string[] = [];
const bytes = Buffer.from("release bytes");
const release = parseRelease({
  name: "fallow-verdict",
  version: "0.2.0",
  tag: "v0.2.0",
  commit: "a".repeat(40),
  file: "fallow-verdict-0.2.0.tgz",
  ...artifactHashes(bytes),
});
const registryMetadata = {
  name: release.name,
  version: release.version,
  dist: {
    integrity: release.integrity,
    tarball: `https://registry.npmjs.org/fallow-verdict/-/${release.file}`,
  },
};
const repository = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), "fallow-verdict-release-test-"));
  directories.push(directory);
  const manifest = { name: release.name, version: release.version };
  await writeFile(path.join(directory, "package.json"), JSON.stringify(manifest));
  await writeFile(
    path.join(directory, "package-lock.json"),
    JSON.stringify({ ...manifest, packages: { "": manifest } }),
  );
  await writeFile(
    path.join(directory, "CHANGELOG.md"),
    "# Changelog\n\n## 0.2.0 (2026-09-23)\n\nExplain the change.\n",
  );
  return directory;
};

afterEach(async (): Promise<void> => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
  vi.useRealTimers();
});

describe("release metadata", (): void => {
  it("requires matching package, lock and dated changelog versions", async (): Promise<void> => {
    const directory = await repository();
    await expect(checkReleaseMetadata(directory, "v0.2.0")).resolves.toBe("0.2.0");
    await expect(checkReleaseMetadata(directory, "v0.3.0")).rejects.toThrow("Invalid input");
    await writeFile(
      path.join(directory, "package-lock.json"),
      JSON.stringify({
        name: release.name,
        version: release.version,
        packages: { "": { name: release.name, version: "0.1.0" } },
      }),
    );
    await expect(checkReleaseMetadata(directory, "v0.2.0")).rejects.toThrow("Invalid input");
  });

  it("rejects an empty or duplicated release section", async (): Promise<void> => {
    const directory = await repository();
    await writeFile(
      path.join(directory, "CHANGELOG.md"),
      "## 0.2.0 (2026-09-23)\n\n## 0.1.0 (2026-09-22)\nOld details.\n",
    );
    await expect(checkReleaseMetadata(directory, "v0.2.0")).rejects.toThrow("empty");
    await writeFile(
      path.join(directory, "CHANGELOG.md"),
      "## 0.2.0 (2026-09-23)\nOne\n## 0.2.0 (2026-09-23)\nTwo\n",
    );
    await expect(checkReleaseMetadata(directory, "v0.2.0")).rejects.toThrow("one dated");
  });

  it.each(["../outside.tgz", "/tmp/outside.tgz", "other.tgz"])(
    "rejects artifact path %s",
    (file: string): void => {
      expect(() => parseRelease({ ...release, file })).toThrow("Unexpected artifact filename");
    },
  );

  it("rejects a locally altered tarball", async (): Promise<void> => {
    const directory = await repository();
    await writeFile(path.join(directory, "release.json"), JSON.stringify(release));
    await writeFile(path.join(directory, release.file), bytes);
    await expect(readRelease(directory)).resolves.toEqual(release);
    await writeFile(path.join(directory, release.file), "changed");
    await expect(readRelease(directory)).rejects.toThrow("does not match");
  });
});

describe("public release verification", (): void => {
  it("checks exact public bytes and optionally the latest tag", async (): Promise<void> => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(registryMetadata))
      .mockResolvedValueOnce(new Response(bytes))
      .mockResolvedValueOnce(Response.json({ version: release.version }));
    await expect(
      verifyPublicRelease(release, { fetch: fetcher, requireLatest: true }),
    ).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "https://registry.npmjs.org/fallow-verdict/0.2.0",
      expect.objectContaining({ redirect: "error" }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      3,
      "https://registry.npmjs.org/fallow-verdict/latest",
      expect.any(Object),
    );
  });

  it("does not retry a mismatched public integrity", async (): Promise<void> => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        ...registryMetadata,
        dist: { ...registryMetadata.dist, integrity: "sha512-other" },
      }),
    );
    await expect(verifyPublicRelease(release, { fetch: fetcher, waitSeconds: 60 })).rejects.toThrow(
      "integrity differs",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects altered public tarball bytes", async (): Promise<void> => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(registryMetadata))
      .mockResolvedValueOnce(new Response("changed"));
    await expect(verifyPublicRelease(release, { fetch: fetcher })).rejects.toThrow("bytes differ");
  });

  it.each([
    "https://evil.example/package.tgz",
    "https://registry.npmjs.org/other/-/package.tgz",
    "https://user:pass@registry.npmjs.org/fallow-verdict/-/fallow-verdict-0.2.0.tgz",
  ])("refuses unexpected tarball URL %s", async (tarball: string): Promise<void> => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ ...registryMetadata, dist: { ...registryMetadata.dist, tarball } }),
      );
    await expect(verifyPublicRelease(release, { fetch: fetcher })).rejects.toThrow(
      "Unexpected public tarball URL",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("fails permanent HTTP errors immediately", async (): Promise<void> => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 403 }));
    await expect(verifyPublicRelease(release, { fetch: fetcher, waitSeconds: 60 })).rejects.toThrow(
      "HTTP 403",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("retries registry propagation within the bounded wait", async (): Promise<void> => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(Response.json(registryMetadata))
      .mockResolvedValueOnce(new Response(bytes));
    const pending = verifyPublicRelease(release, { fetch: fetcher, waitSeconds: 30 });
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(pending).resolves.toBeUndefined();
  });

  it("rejects unbounded polling", async (): Promise<void> => {
    await expect(verifyPublicRelease(release, { waitSeconds: 3601 })).rejects.toThrow(
      "wait-seconds",
    );
  });
});
