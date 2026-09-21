import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { configSchema } from "../src/config/schema.ts";
import { corpusLabelsSchema, prepareCorpus } from "../src/eval/corpus.ts";
import { parseSecurityOutput } from "../src/fallow/run.ts";
import { LABELS_SCHEMA } from "../src/eval/metrics.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const corpus = path.join(root, "eval/corpus");
const cli = path.join(root, "bin/fallow-verdict.js");
const { values } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    rejudge: { type: "boolean", default: false },
    "question-profile": { type: "string", default: "generic" },
  },
});
const profile = configSchema.parse({ questionProfile: values["question-profile"] }).questionProfile;
const dryRun = values["dry-run"];

const invoke = (args: string[]): number => {
  const result = spawnSync(
    process.execPath,
    [cli, ...args, "--cwd", corpus, "--question-profile", profile],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        PATH: `${path.join(root, "node_modules/.bin")}${path.delimiter}${process.env.PATH ?? ""}`,
      },
    },
  );
  if (result.error) throw result.error;
  return result.status ?? 2;
};

const scanStatus = invoke(["scan"]);
if (scanStatus !== 0) process.exit(scanStatus);
const parsed = parseSecurityOutput(
  JSON.parse(
    await readFile(path.join(corpus, ".fallow-verdict/candidates.json"), "utf8"),
  ) as unknown,
);
if (!parsed.ok) throw new Error(parsed.error.message);
const cases = corpusLabelsSchema.parse(
  JSON.parse(await readFile(path.join(root, "eval/cases.json"), "utf8")),
);
await prepareCorpus(parsed.data, cases, { root: corpus, ...configSchema.parse({}).packet });
const labelsPath = path.join(corpus, ".fallow-verdict/labels.json");
await writeFile(
  labelsPath,
  JSON.stringify(
    {
      schema_version: LABELS_SCHEMA,
      labels: parsed.data.security_findings.map((finding) => ({
        finding_id: finding.finding_id,
        expected: cases[finding.path]?.expected,
        note: cases[finding.path]?.rationale,
      })),
    },
    null,
    2,
  ),
);
const judgeStatus = invoke([
  "judge",
  "--max-cost-usd",
  "0.05",
  ...(dryRun ? ["--dry-run"] : []),
  ...(values.rejudge ? ["--rejudge"] : []),
]);
if (judgeStatus !== 0 || dryRun) process.exit(judgeStatus);
const reportStatus = invoke(["report", "--show-dismissed"]);
if (reportStatus > 1) process.exit(reportStatus);
process.exitCode = invoke(["eval", "--labels", labelsPath, "--format", "json"]);
