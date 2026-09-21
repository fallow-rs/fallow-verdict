import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { z } from "zod";

import { configSchema } from "../src/config/schema.ts";
import { createJevEngine } from "../src/engine/jev.ts";
import { compareQuestions, digest } from "../src/eval/comparison.ts";
import { prepareCorpus } from "../src/eval/corpus.ts";
import { runSecurityScan } from "../src/fallow/run.ts";
import { questionsFor } from "../src/questions/category.ts";

const { values } = parseArgs({
  options: {
    dataset: { type: "string", default: "development" },
    repeats: { type: "string", default: "3" },
    model: { type: "string", default: "jev-1.13.0" },
    output: { type: "string" },
    "max-cost-usd": { type: "string", default: "0.05" },
    "dry-run": { type: "boolean", default: false },
  },
});
const dataset = z.enum(["development", "holdout"]).parse(values.dataset);
if (!values["dry-run"] && values.output === undefined)
  throw new Error("Live comparisons require --output to preserve answers for review.");
const root = fileURLToPath(new URL("../", import.meta.url));
const corpus = path.join(root, dataset === "development" ? "eval/corpus" : "eval/holdout");
const labelsPath = path.join(
  root,
  dataset === "development" ? "eval/cases.json" : "eval/holdout-cases.json",
);
const config = configSchema.parse({ engine: { model: values.model } });
const scan = await runSecurityScan({
  root: corpus,
  binary: path.join(root, "node_modules/.bin/fallow"),
});
if (!scan.ok) throw new Error(scan.error.message);
const prepared = await prepareCorpus(
  scan.data,
  JSON.parse(await readFile(labelsPath, "utf8")) as unknown,
  { root: corpus, ...config.packet },
);
const questionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("noul"),
    instructions: z.string(),
    criteria: z.object({ true: z.string(), false: z.string() }),
  }),
  z.object({
    type: z.literal("choice"),
    instructions: z.string(),
    criteria: z.record(z.string(), z.string()),
  }),
  z.object({ type: z.literal("score"), instructions: z.string(), criteria: z.array(z.string()) }),
]);
const baseline = z
  .object({
    source_commit: z.string(),
    question_set: z.string(),
    questions: z.record(z.string(), questionSchema),
  })
  .parse(JSON.parse(await readFile(path.join(root, "eval/baselines/questions-v1.json"), "utf8")));
const freeze = z
  .object({ frozenAt: z.string(), questionHashes: z.record(z.string(), z.string()) })
  .parse(
    JSON.parse(await readFile(path.join(root, "eval/baselines/category-v2-freeze.json"), "utf8")),
  );
for (const item of prepared.cases) {
  const category = item.built.packet.category;
  const key = category !== null && category in freeze.questionHashes ? category : "fallback";
  if (digest(questionsFor(item.built.packet)) !== freeze.questionHashes[key])
    throw new Error(
      "Candidate question content changed after the evaluation freeze. Create a new version and development comparison first.",
    );
}
const apiKey = process.env.TYPESAFE_API_KEY;
if (!values["dry-run"] && !apiKey)
  throw new Error("Set TYPESAFE_API_KEY before running a live comparison.");
const comparison = {
  cases: prepared.cases,
  variants: [
    { id: "generic-v1", questions: () => baseline.questions },
    { id: "category-v2", questions: questionsFor },
  ],
  engine: createJevEngine({ apiKey: apiKey ?? "unused-dry-run", model: values.model }),
  model: values.model,
  policy: config.policy,
  repeats: Number(values.repeats),
  maxCostUsd: Number(values["max-cost-usd"]),
};
let report = await compareQuestions({ ...comparison, dryRun: true });
const metadata = {
  dataset,
  corpusHash: prepared.corpusHash,
  fallowVersion: scan.data.version,
  baselineCommit: baseline.source_commit,
  candidateFrozenAt: freeze.frozenAt,
};
if (!values["dry-run"] && values.output !== undefined) {
  // Verify artifact storage before making paid calls; interrupted runs leave an incomplete plan.
  await writeFile(
    path.resolve(values.output),
    `${JSON.stringify({ ...report, ...metadata }, null, 2)}\n`,
  );
  process.stderr.write(
    `Estimated request cost: $${report.estimatedUsd.toFixed(6)}; budget: $${comparison.maxCostUsd.toFixed(6)}. Results: ${path.resolve(values.output)}\n`,
  );
  report = await compareQuestions({ ...comparison, dryRun: false });
}
const artifact = { ...report, ...metadata };
if (values.output !== undefined)
  await writeFile(path.resolve(values.output), `${JSON.stringify(artifact, null, 2)}\n`);
process.stdout.write(
  `${JSON.stringify({ dataset, corpusHash: prepared.corpusHash, complete: report.complete, estimatedUsd: report.estimatedUsd, costUsd: report.costUsd, stopError: report.stopError, summaries: report.summaries }, null, 2)}\n`,
);
process.exitCode = values["dry-run"]
  ? 0
  : !report.complete
    ? 2
    : report.summaries.some(
          (summary) => summary.unsafeDismissals.length > 0 || summary.reviewGuardMisses.length > 0,
        )
      ? 1
      : 0;
