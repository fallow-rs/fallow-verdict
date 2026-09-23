import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

const verifier = fileURLToPath(new URL("../scripts/verify-package.ts", import.meta.url));

it.each(["latest", "^0.1.0", "0.1", "01.2.3", "1.0.0-01", "https://example.com/package.tgz"])(
  "rejects a non-exact published version: %s",
  (version) => {
    const result = spawnSync(process.execPath, [verifier, "--published", version], {
      encoding: "utf8",
      timeout: 10_000,
      env: {},
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--published requires an exact semantic version");
  },
);

it("rejects simultaneous tarball and registry package sources before running npm", () => {
  const result = spawnSync(
    process.execPath,
    [verifier, "--tarball", "/tmp/release.tgz", "--published", "0.1.0"],
    { encoding: "utf8", timeout: 10_000, env: {} },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Use either --tarball or --published, not both.");
});
