import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { configSchema } from "../src/config/schema.ts";
import type { LoadedConfig } from "../src/config/load.ts";

const repo = fileURLToPath(new URL("../", import.meta.url));
const FIXTURES = path.join(repo, "test/fixtures/mutation");
const CORPUS = path.join(repo, "eval/mutation/corpus");

export const readFixture = async (name: string): Promise<unknown> =>
  JSON.parse(await readFile(path.join(FIXTURES, name), "utf8")) as unknown;

/** The Fallow error envelope that a runner without replay support prints. */
export const REPLAY_UNSUPPORTED = {
  error: true,
  message: "the bun test runner does not replay a mutant",
  exit_code: 2,
  code: "FALLOW_MUTATION_REPLAY_UNSUPPORTED",
};

export type StubProject = {
  root: string;
  loaded: LoadedConfig;
  /** One JSON line for each Fallow call: the arguments. */
  argsLog: string;
  /** Replace the `tasks` document that the stub prints. */
  setTasks: (value: unknown) => Promise<void>;
  /** Replace the inspect document of one mutant. `replay` sets the `--replay` document. */
  setInspect: (id: string, value: unknown, replay?: boolean) => Promise<void>;
  calls: () => Promise<string[][]>;
};

/**
 * A copy of the mutation corpus with a stub `fallow`. The stub prints the recorded Fallow output
 * from the fixtures, because a real run starts the test runner for each mutant. It logs every call.
 */
export const stubProject = async (config: Record<string, unknown> = {}): Promise<StubProject> => {
  const root = await mkdtemp(path.join(tmpdir(), "verdict-mutation-"));
  await cp(CORPUS, root, { recursive: true });
  const data = path.join(root, ".stub");
  await cp(FIXTURES, data, { recursive: true });
  const argsLog = path.join(root, ".args.log");
  const binary = path.join(root, ".fallow-stub.mjs");
  await writeFile(
    binary,
    [
      "#!/usr/bin/env node",
      'import { appendFileSync, existsSync, readFileSync } from "node:fs";',
      'import path from "node:path";',
      "const args = process.argv.slice(2);",
      `const data = ${JSON.stringify(data)};`,
      `appendFileSync(${JSON.stringify(argsLog)}, JSON.stringify(args) + "\\n");`,
      "const print = (file) => {",
      "  const text = readFileSync(file, 'utf8');",
      "  process.stdout.write(text);",
      "  process.exit(JSON.parse(text).error === true ? 2 : 0);",
      "};",
      'if (args[0] === "mutation" && args[1] === "tasks") print(path.join(data, "tasks.json"));',
      'if (args[0] === "mutation" && args[1] === "inspect") {',
      '  const replay = args.includes("--replay");',
      '  const file = path.join(data, replay ? "replay" : "inspect", `${args[2]}.json`);',
      "  if (existsSync(file)) print(file);",
      '  process.stdout.write(JSON.stringify({ error: true, message: "unknown mutant", exit_code: 2, code: "FALLOW_MUTATION_UNKNOWN_MUTANT" }));',
      "  process.exit(2);",
      "}",
      'process.stderr.write("unexpected call");',
      "process.exit(2);",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const loaded: LoadedConfig = {
    config: configSchema.parse({ ...config, fallow: { binary } }),
    root,
    dataDir: path.join(root, ".fallow-verdict"),
    configPath: null,
  };
  return {
    root,
    loaded,
    argsLog,
    setTasks: (value) => writeFile(path.join(data, "tasks.json"), JSON.stringify(value)),
    setInspect: (id, value, replay = false) =>
      writeFile(
        path.join(data, replay ? "replay" : "inspect", `${id}.json`),
        JSON.stringify(value),
      ),
    calls: async () => {
      const text = await readFile(argsLog, "utf8").catch(() => "");
      return text
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as string[]);
    },
  };
};
