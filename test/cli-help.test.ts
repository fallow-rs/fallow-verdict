import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { COMMANDS, parseCli } from "../src/cli/args.ts";

const repo = fileURLToPath(new URL("../", import.meta.url));
const cli = path.join(repo, "bin/fallow-verdict.js");

const runCli = (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    execFile(process.execPath, [cli, ...args], (error, stdout, stderr) => {
      if (error !== null && typeof error.code !== "number") return reject(error);
      resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
    });
  });

/** The option names in the Options section of a help text. */
const optionsOf = (help: string): string[] =>
  [
    ...(help.split("\nOptions\n")[1]?.split("\nExit codes")[0] ?? "").matchAll(
      /^ {2}(?:-h, )?(--[a-z][a-z-]*)/gm,
    ),
  ].map((match) => match[1] ?? "");

/** The options that each command accepts. The help of each command must list exactly these. */
const EXPECTED: Readonly<Record<(typeof COMMANDS)[number], readonly string[]>> = {
  init: ["--cwd", "--format", "--quiet"],
  scan: ["--config", "--kind", "--cwd", "--format", "--quiet", "--changed-since"],
  judge: [
    "--config",
    "--kind",
    "--question-profile",
    "--cwd",
    "--format",
    "--quiet",
    "--rejudge",
    "--dry-run",
    "--limit",
    "--max-cost-usd",
    "--max-duration",
  ],
  report: [
    "--config",
    "--kind",
    "--question-profile",
    "--cwd",
    "--format",
    "--quiet",
    "--fail-on",
    "--show-dismissed",
    "--no-validate",
  ],
  run: [
    "--config",
    "--kind",
    "--question-profile",
    "--cwd",
    "--format",
    "--quiet",
    "--changed-since",
    "--rejudge",
    "--dry-run",
    "--limit",
    "--max-cost-usd",
    "--max-duration",
    "--fail-on",
    "--show-dismissed",
    "--no-validate",
  ],
  status: ["--config", "--kind", "--cwd", "--format", "--quiet", "--show-dismissed"],
  eval: ["--config", "--kind", "--question-profile", "--cwd", "--format", "--quiet", "--labels"],
  check: ["--config", "--kind", "--question-profile", "--cwd", "--format", "--quiet", "--dry-run"],
  close: ["--config", "--kind", "--cwd", "--format", "--quiet", "--reason"],
};

describe("help for each command", () => {
  it.each(COMMANDS)("%s --help shows its usage, options and exit codes", async (command) => {
    const result = await runCli([command, "--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`\nUsage\n  fallow-verdict ${command}`);
    expect(optionsOf(result.stdout)).toEqual([...EXPECTED[command], "--help"]);
    expect(result.stdout).toMatch(/\nExit codes\n {2}0 {4}\S/);
    expect(result.stdout).not.toContain("\nCommands\n");
  });

  it.each(COMMANDS)("help %s prints the same text as %s --help", async (command) => {
    const [viaHelp, viaFlag] = await Promise.all([
      runCli(["help", command]),
      runCli([command, "-h"]),
    ]);
    expect(viaHelp).toEqual(viaFlag);
  });

  it("keeps the overview for --help alone, with every command and option", async () => {
    const result = await runCli(["--help"]);
    expect(result.code).toBe(0);
    for (const command of COMMANDS)
      expect(result.stdout).toMatch(new RegExp(`^ {2}${command} `, "m"));
    const all = new Set(Object.values(EXPECTED).flat());
    expect(optionsOf(result.stdout).toSorted()).toEqual([...all, "--help", "--version"].toSorted());
  });

  it("rejects help for an unknown command", async () => {
    const result = await runCli(["help", "deploy"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Unknown command `deploy`.");
  });

  it("shows the exit code 3 only for check", async () => {
    for (const command of COMMANDS) {
      const { stdout } = await runCli([command, "--help"]);
      expect(/^ {2}3 {4}/m.test(stdout)).toBe(command === "check");
    }
  });
});

describe("options that a command does not accept", () => {
  it("exit 2 and name the command and the option", async () => {
    const result = await runCli(["status", "--dry-run"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("`status` does not accept --dry-run.");
    expect(result.stderr).toContain("fallow-verdict status --help");
  });

  it.each(COMMANDS)("are usage errors for %s", (command) => {
    const accepted = new Set(EXPECTED[command]);
    const all = new Set(Object.values(EXPECTED).flat());
    for (const flag of all) {
      if (accepted.has(flag)) continue;
      const value = [
        "--rejudge",
        "--dry-run",
        "--quiet",
        "--show-dismissed",
        "--no-validate",
      ].includes(flag)
        ? []
        : ["1"];
      const parsed = parseCli([command, "x", flag, ...value]);
      expect(parsed).toMatchObject({
        ok: false,
        error: { code: "config_invalid", message: `\`${command}\` does not accept ${flag}.` },
      });
    }
  });

  it("do not block help", () => {
    expect(parseCli(["status", "--dry-run", "--help"])).toEqual({
      ok: true,
      data: { kind: "help", command: "status" },
    });
  });
});
