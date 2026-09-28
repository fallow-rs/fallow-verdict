import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

import { checkReportSchema } from "../src/report/check.ts";

const repo = fileURLToPath(new URL("../", import.meta.url));
const cli = path.join(repo, "bin/fallow-verdict.js");

/** Runs the built CLI with no API key, so any Jev request fails. */
const runCli = (root: string, args: string[]): Promise<{ code: number; data: unknown }> =>
  new Promise((resolve, reject) => {
    const { TYPESAFE_API_KEY: _key, ...env } = process.env;
    execFile(
      process.execPath,
      [cli, ...args, "--cwd", root, "--format", "json"],
      { env },
      (error, stdout) => {
        if (error !== null && typeof error.code !== "number") return reject(error);
        let data: unknown;
        try {
          data = JSON.parse(stdout) as unknown;
        } catch (cause) {
          return reject(cause);
        }
        resolve({ code: typeof error?.code === "number" ? error.code : 0, data });
      },
    );
  });

it("checks and closes findings with the built CLI and real fallow", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "verdict-check-"));
  try {
    await cp(path.join(repo, "eval/corpus/src"), path.join(root, "src"), { recursive: true });
    await cp(path.join(repo, "eval/corpus/package.json"), path.join(root, "package.json"));
    await writeFile(
      path.join(root, "fallow-verdict.config.json"),
      JSON.stringify({ fallow: { binary: path.join(repo, "node_modules/.bin/fallow") } }),
    );
    expect(await runCli(root, ["scan"])).toMatchObject({ code: 0 });
    const candidates = JSON.parse(
      await readFile(path.join(root, ".fallow-verdict/candidates.json"), "utf8"),
    ) as { security_findings: { finding_id: string; path: string }[] };
    const id = candidates.security_findings.find(
      (finding) => finding.path === "src/lookup.ts",
    )?.finding_id;
    if (id === undefined) throw new Error("fallow reported no finding in src/lookup.ts");

    const source = path.join(root, "src/lookup.ts");
    const original = await readFile(source, "utf8");
    await writeFile(source, `// Added line.\n${original}`);
    const moved = await runCli(root, ["check", id, "--dry-run"]);
    expect(moved).toMatchObject({
      code: 0,
      data: { outcome: "estimated", results: [{ status: "not-assessed", stored_id: id }] },
    });
    expect(checkReportSchema.safeParse(moved.data).success).toBe(true);
    expect((moved.data as { results: { finding_id: string }[] }).results[0]?.finding_id).not.toBe(
      id,
    );

    expect(await runCli(root, ["check", "src/lookup.ts"])).toMatchObject({
      code: 2,
      data: { outcome: "error", results: [{ error: { code: "engine_auth_failed" } }] },
    });

    await writeFile(source, "export const lookup = (): string => 'none';\n");
    expect(await runCli(root, ["check", id])).toMatchObject({
      code: 0,
      data: { outcome: "cleared", results: [{ status: "resolved", stored_id: id }] },
    });

    await writeFile(source, original);
    expect(await runCli(root, ["close", id, "--reason", "Fixed origin."])).toMatchObject({
      code: 0,
      data: { finding_id: id, closed: { reason: "Fixed origin." } },
    });
    expect(await runCli(root, ["check", id])).toMatchObject({
      code: 0,
      data: { results: [{ status: "closed", reason: "Fixed origin." }] },
    });
    // `fallow security survivors` validates the export; the other findings are still pending.
    const report = await runCli(root, ["report"]);
    expect(report).toMatchObject({ code: 2, data: { summary: { closed: 1 } } });
    expect(report.data).not.toHaveProperty("error");
    const verdicts = JSON.parse(
      await readFile(path.join(root, ".fallow-verdict/verdicts.json"), "utf8"),
    ) as { verdicts: unknown[] };
    expect(verdicts.verdicts).toEqual([
      expect.objectContaining({
        finding_id: id,
        verdict: "dismissed",
        reason: "Closed by a person: Fixed origin.",
      }),
    ]);
    expect(await runCli(root, ["check", "missing-id"])).toMatchObject({
      code: 2,
      data: { error: true, code: "config_invalid" },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
