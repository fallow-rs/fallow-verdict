import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repo = fileURLToPath(new URL("../", import.meta.url));
const skillsDir = path.join(repo, "skills");
const cli = path.join(repo, "bin/fallow-verdict.js");
const EM_DASH = String.fromCharCode(0x2014);

const help = execFileSync(process.execPath, [cli, "--help"], { encoding: "utf8" });

// The skills follow the real CLI: every name below comes from the help text.
const helpFlags = new Set([...help.matchAll(/^\s+(?:-h, )?(--[a-z][a-z-]*)/gm)].map((m) => m[1]));
const helpCommands = new Set(
  [...(help.split("\nOptions")[0] ?? "").matchAll(/^ {2}([a-z]+) {2,}/gm)].map((m) => m[1]),
);
const helpKinds = (/Known kinds: (.+)/.exec(help)?.[1] ?? "").split(/,\s*/);

const skillNames = readdirSync(skillsDir).filter((name) =>
  statSync(path.join(skillsDir, name)).isDirectory(),
);

const markdownFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) return markdownFiles(file);
    return name.endsWith(".md") ? [file] : [];
  });

const allFiles = markdownFiles(skillsDir);

/** Code spans and lines of fenced code blocks: the places where the skills name commands. */
const codeSnippets = (text: string): string[] => {
  const blocks = [...text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].flatMap((m) =>
    (m[1] ?? "").split("\n"),
  );
  const prose = text.replace(/```[a-z]*\n[\s\S]*?```/g, "");
  const spans = [...prose.matchAll(/`([^`\n]+)`/g)].map((m) => m[1] ?? "");
  return [...blocks, ...spans].map((snippet) => snippet.trim()).filter((s) => s.length > 0);
};

type Command = { tool: "fallow-verdict" | "fallow" | "flag"; words: string[] };

/** A snippet that starts with `--` is an option of fallow-verdict. Fallow options stay in full `fallow ...` commands. */
const commandOf = (snippet: string): Command | null => {
  const words = snippet.replace(/^npx /, "").split(/\s+/);
  if (words[0] === "fallow-verdict") return { tool: "fallow-verdict", words: words.slice(1) };
  if (words[0] === "fallow") return { tool: "fallow", words: words.slice(1) };
  if (words[0]?.startsWith("--") === true) return { tool: "flag", words };
  return null;
};

const commands = allFiles.flatMap((file) =>
  codeSnippets(readFileSync(file, "utf8")).flatMap((snippet) => {
    const command = commandOf(snippet);
    return command === null ? [] : [{ file: path.relative(repo, file), snippet, command }];
  }),
);

describe("skills", () => {
  it("ship in the npm package", () => {
    const pkg = JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8")) as {
      files: string[];
    };
    expect(pkg.files).toContain("skills");
  });

  it("include the four planned skills", () => {
    expect(skillNames.toSorted()).toEqual([
      "fallow-verdict-review",
      "fallow-verdict-rules",
      "fallow-verdict-security-triage",
      "fallow-verdict-similar-code",
    ]);
  });

  it.each(skillNames)("%s has valid front matter", (name) => {
    const text = readFileSync(path.join(skillsDir, name, "SKILL.md"), "utf8");
    const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
    expect(match).not.toBeNull();
    const fields = Object.fromEntries(
      (match?.[1] ?? "").split("\n").map((line) => {
        const at = line.indexOf(":");
        return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
      }),
    );
    expect(Object.keys(fields).toSorted()).toEqual(["description", "license", "name"]);
    expect(fields["name"]).toBe(name);
    expect(fields["license"]).toBe("MIT");
    expect(fields["description"]).toMatch(/Use when/);
    expect(fields["description"]?.length ?? 0).toBeLessThanOrEqual(1024);
  });

  it("read the commands, options and kinds from the help text", () => {
    expect(helpFlags).toContain("--fail-on");
    expect(helpCommands).toContain("check");
    expect(helpKinds).toContain("security");
    expect(commands.some((c) => c.command.tool === "fallow-verdict")).toBe(true);
  });

  it("name only commands and options that the CLI has", () => {
    const unknown = commands.flatMap(({ file, snippet, command }) => {
      if (command.tool === "fallow") return [];
      const problems: string[] = [];
      const [first] = command.words;
      if (command.tool === "fallow-verdict" && first !== undefined && !first.startsWith("-")) {
        if (!helpCommands.has(first)) problems.push(`command ${first}`);
      }
      for (const word of command.words) {
        const flag = /^(--[a-z][a-z-]*)/.exec(word)?.[1];
        if (flag !== undefined && !helpFlags.has(flag)) problems.push(`option ${flag}`);
      }
      return problems.map((problem) => `${file}: ${problem} in \`${snippet}\``);
    });
    expect(unknown).toEqual([]);
  });

  it("name only known kinds", () => {
    const kinds = commands.flatMap(({ command }) => {
      if (command.tool === "fallow") return [];
      const at = command.words.indexOf("--kind");
      const value = at === -1 ? undefined : command.words[at + 1];
      return value === undefined || value.startsWith("<") ? [] : [value];
    });
    expect(kinds.length).toBeGreaterThan(0);
    for (const kind of kinds) expect(helpKinds).toContain(kind);
  });

  it("pass --fail-on off to each real run and each report", () => {
    const runs = commands.filter(
      ({ command }) =>
        command.tool === "fallow-verdict" &&
        (command.words[0] === "run" || command.words[0] === "report") &&
        !command.words.includes("--dry-run"),
    );
    expect(runs.length).toBeGreaterThan(0);
    for (const { snippet } of runs) expect(snippet).toContain("--fail-on off");
  });

  it.each(skillNames)("%s states the shared rules", (name) => {
    const text = readFileSync(path.join(skillsDir, name, "SKILL.md"), "utf8");
    for (const needle of ["--dry-run", "--fail-on off", "TYPESAFE_API_KEY", "hook", "--help"]) {
      expect(text).toContain(needle);
    }
  });

  it("select similar-code pairs by the survivor verdict, not by refactor_safe alone", () => {
    const text = readFileSync(
      path.join(skillsDir, "fallow-verdict-similar-code", "SKILL.md"),
      "utf8",
    );
    expect(text).toMatch(/decision\.verdict`? is `"?survivor"?`/);
    expect(text).not.toMatch(/Select the findings where `decision\.kindData\.refactor_safe`/);
  });

  it.each(skillNames)("%s stops on a rejected key", (name) => {
    const text = readFileSync(path.join(skillsDir, name, "SKILL.md"), "utf8");
    expect(text).toContain("engine_auth_failed");
  });

  it("contain no em-dash", () => {
    for (const file of allFiles) expect(readFileSync(file, "utf8")).not.toContain(EM_DASH);
  });
});
