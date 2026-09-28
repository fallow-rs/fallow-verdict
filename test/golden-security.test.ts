import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

import { judge } from "../src/pipeline/judge.ts";
import { syncRecords } from "../src/pipeline/scan.ts";
import { buildReport, renderHuman, renderMarkdown } from "../src/report/render.ts";
import { securityPresentation, securityPriority } from "../src/report/security.ts";
import { openStore } from "../src/state/store.ts";
import { toVerdictsFile } from "../src/verdicts/export.ts";
import {
  makeFinding,
  makeLoaded,
  makeOutput,
  makeProject,
  mockEngine,
  SAFE_MITIGATED,
  VULNERABLE,
} from "./helpers.ts";

/**
 * The fixtures are the output of origin/main at 69f0ead, before analysis kinds existed. They
 * were made with the same steps as below, with the main API (`openStore(dataDir)`,
 * `buildReport(records)`, `renderHuman(report, true)`, `renderMarkdown(report)`), and the same
 * `normalize` function.
 */
const FIXTURES = fileURLToPath(new URL("./fixtures/golden-security/", import.meta.url));

/** Only timestamps, run ids (a timestamp plus a random suffix) and the project root change. */
const normalize = (text: string, root: string): string =>
  text
    .replaceAll(root, "<root>")
    .replaceAll(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<timestamp>")
    .replaceAll(/\b\d{14}-[0-9a-f]{8}\b/g, "<run-id>");

/** The one intended change since main: each record stores its kind after the schema version. */
const withKind = (text: string): string =>
  text.replaceAll(
    /^( *)("schema_version": "fallow-verdict-record\/v1",\n)/gm,
    '$1$2$1"kind": "security",\n',
  );

const produce = async (): Promise<Record<string, string>> => {
  const root = await makeProject();
  const loaded = makeLoaded(root, { engine: { concurrency: 1 } });
  const store = openStore(loaded.dataDir, "security");
  const findings = [
    makeFinding(),
    makeFinding({
      finding_id: "security:tainted-sink:src/routes/user.ts:5:40",
      col: 40,
      severity: "medium",
    }),
    makeFinding({
      finding_id: "security:tainted-sink:src/routes/user.ts:4",
      line: 4,
      col: 13,
      severity: "low",
      category: "ssrf",
    }),
  ];
  const output = makeOutput(findings);
  await store.writeJson(store.candidatesPath, output);
  await syncRecords(store, output, false);
  const responses = [VULNERABLE, SAFE_MITIGATED, { ...VULNERABLE, tampering: 0.9 }];
  let call = 0;
  const engine = mockEngine(() => responses[call++] ?? VULNERABLE);
  await judge(loaded, store, engine, { rejudge: false, dryRun: false });

  const findingsDir = path.join(loaded.dataDir, "findings");
  const names = (await readdir(findingsDir)).toSorted();
  const raw = [];
  for (const name of names)
    raw.push(`findings/${name}\n${await readFile(path.join(findingsDir, name), "utf8")}`);
  const { records } = await store.readRecords();
  const report = buildReport(records, securityPriority);
  const ids = new Set(findings.map((finding) => finding.finding_id));
  const files: Record<string, string> = {
    "records.txt": raw.join("\n"),
    "report.json": `${JSON.stringify(report, null, 2)}\n`,
    "report.txt": `${renderHuman(report, securityPresentation, true)}\n`,
    "report.md": renderMarkdown(report, securityPresentation),
    "verdicts.json": `${JSON.stringify(toVerdictsFile(records, ids), null, 2)}\n`,
  };
  return Object.fromEntries(
    Object.entries(files).map(([name, content]) => [name, normalize(content, root)]),
  );
};

it("writes the same security records, reports and verdicts as before analysis kinds", async () => {
  const produced = await produce();
  expect(Object.keys(produced).toSorted()).toEqual((await readdir(FIXTURES)).toSorted());
  for (const [name, content] of Object.entries(produced)) {
    const golden = await readFile(path.join(FIXTURES, name), "utf8");
    const expected = name === "records.txt" || name === "report.json" ? withKind(golden) : golden;
    expect({ name, content }).toEqual({ name, content: expected });
  }
});
