import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { evaluateMutation, mutationLabelsSchema } from "../src/eval/mutation.ts";
import type { StoredDecision } from "../src/state/schema.ts";
import { openStore } from "../src/state/store.ts";

/**
 * Runs the mutation kind on prepared project copies and scores the decisions against
 * `eval/mutation/labels.json`. Each copy must hold a saved `fallow mutation` report of the
 * command in the label file. Usage:
 *
 *   node scripts/evaluate-mutation.ts --project defu=/path/to/defu --project ufo=/path/to/ufo \
 *     [--repeats 2] [--max-cost-usd 0.05] [--dry-run] [--out eval/mutation/results/run.json]
 */
const root = fileURLToPath(new URL("../", import.meta.url));
const cli = path.join(root, "bin/fallow-verdict.js");
const KIND = "mutation";

const { values } = parseArgs({
  options: {
    project: { type: "string", multiple: true, default: [] },
    repeats: { type: "string", default: "1" },
    "max-cost-usd": { type: "string", default: "0.05" },
    "dry-run": { type: "boolean", default: false },
    out: { type: "string" },
  },
});

const projects = new Map(
  values.project.map((entry) => {
    const [id, dir] = entry.split("=");
    if (id === undefined || dir === undefined)
      throw new Error(`Use --project <id>=<dir>, not ${entry}.`);
    return [id, path.resolve(dir)];
  }),
);
const repeats = Number(values.repeats);
const labels = mutationLabelsSchema.parse(
  JSON.parse(await readFile(path.join(root, "eval/mutation/labels.json"), "utf8")),
);

const invoke = (dir: string, args: string[]): number => {
  const result = spawnSync(
    process.execPath,
    [cli, ...args, "--kind", KIND, "--cwd", dir, "--quiet"],
    {
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
  if (result.error) throw result.error;
  return result.status ?? 2;
};

type Observation = {
  project: string;
  id: string;
  repeat: number;
  expected: string;
  verdict: StoredDecision["verdict"];
  rule: string;
  probabilities: Record<string, number>;
  answers: unknown;
  confirmationAnswers: unknown;
  model: string | null;
};

const observations: Observation[] = [];
let costUsd = 0;
for (let repeat = 0; repeat < repeats; repeat += 1) {
  for (const [id, dir] of projects) {
    if (repeat === 0 && invoke(dir, ["scan"]) !== 0) throw new Error(`scan failed for ${id}`);
    const judged = invoke(dir, [
      "judge",
      "--max-cost-usd",
      values["max-cost-usd"],
      ...(values["dry-run"] ? ["--dry-run"] : []),
      ...(repeat > 0 ? ["--rejudge"] : []),
    ]);
    if (judged !== 0) throw new Error(`judge failed for ${id} (exit ${judged})`);
    if (values["dry-run"]) continue;
    const { records } = await openStore(path.join(dir, ".fallow-verdict"), KIND).readRecords();
    const byId = new Map(records.map((record) => [record.finding_id, record]));
    for (const label of labels.labels.filter((entry) => entry.project === id)) {
      const record = byId.get(label.id);
      if (record?.decision == null) throw new Error(`no decision for ${label.id} in ${id}`);
      costUsd += record.usage?.costUsd ?? 0;
      observations.push({
        project: id,
        id: label.id,
        repeat,
        expected: label.expected,
        verdict: record.decision.verdict,
        rule: record.decision.rule,
        probabilities: record.decision.probabilities,
        answers: record.answers,
        confirmationAnswers: record.confirmationAnswers ?? null,
        model: record.history.at(-1)?.model ?? null,
      });
    }
  }
}
if (values["dry-run"]) process.exit(0);

const metrics = (split: string, repeat: number) => {
  const scoped = labels.labels.filter(
    (label) => label.split === split && projects.has(label.project),
  );
  const decisions = new Map(
    observations
      .filter((entry) => entry.repeat === repeat)
      .map((entry) => [entry.id, { verdict: entry.verdict }]),
  );
  return { split, repeat, ...evaluateMutation(scoped, decisions) };
};

/** Mutants whose verdict differs between repeats. */
const unstable = [...new Set(observations.map((entry) => entry.id))].filter(
  (id) =>
    new Set(observations.filter((entry) => entry.id === id).map((entry) => entry.verdict)).size > 1,
);

const result = {
  schema_version: "fallow-verdict-mutation-eval/v1",
  startedAt: new Date().toISOString(),
  projects: [...projects.keys()],
  repeats,
  costUsd,
  metrics: ["development", "holdout"].flatMap((split) =>
    Array.from({ length: repeats }, (_, repeat) => metrics(split, repeat)),
  ),
  unstable,
  observations,
};
const out = values.out ?? path.join(root, "eval/mutation/results/latest.json");
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ out, costUsd, metrics: result.metrics, unstable }, null, 2));
