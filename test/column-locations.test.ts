import { expect, it } from "vitest";

import { judge, refreshVerdicts } from "../src/pipeline/judge.ts";
import { syncRecords } from "../src/pipeline/scan.ts";
import { buildReport, renderHuman, renderMarkdown } from "../src/report/render.ts";
import { securityPresentation, securityPriority } from "../src/report/security.ts";
import { recordSchema } from "../src/state/schema.ts";
import { openStore } from "../src/state/store.ts";
import {
  makeFinding,
  makeLoaded,
  makeOutput,
  makeProject,
  mockEngine,
  SAFE_MITIGATED,
} from "./helpers.ts";

it("preserves and reports distinct columns for findings on the same source line", async () => {
  const loaded = makeLoaded(await makeProject());
  const store = openStore(loaded.dataDir, "security");
  const findings = [0, 42].map((col) => makeFinding({ finding_id: `finding-${col}`, col }));
  const output = makeOutput(findings);
  await store.writeJson(store.candidatesPath, output);
  await syncRecords(store, output, false, loaded);
  const pending = (await store.readRecords()).records;
  expect(pending.map((record) => record.col).toSorted((a, b) => (a ?? -1) - (b ?? -1))).toEqual([
    0, 42,
  ]);
  for (const rendered of [
    renderHuman(buildReport(pending, securityPriority), securityPresentation, true),
    renderMarkdown(buildReport(pending, securityPriority), securityPresentation),
  ]) {
    expect(rendered).toContain("src/routes/user.ts:5:0");
    expect(rendered).toContain("src/routes/user.ts:5:42");
    expect(rendered.match(/No current assessment\./g)).toHaveLength(1);
  }
  await judge(
    loaded,
    store,
    mockEngine(() => SAFE_MITIGATED),
    { rejudge: false, dryRun: false },
  );
  const judged = (await store.readRecords()).records;
  for (const rendered of [
    renderHuman(buildReport(judged, securityPriority), securityPresentation, true),
    renderMarkdown(buildReport(judged, securityPriority), securityPresentation),
  ]) {
    expect(rendered).toContain("src/routes/user.ts:5:0");
    expect(rendered).toContain("src/routes/user.ts:5:42");
  }

  const first = judged[0];
  if (first === undefined) throw new Error("Missing record");
  const { col: _col, ...legacy } = first;
  const oldRecord = recordSchema.parse(legacy);
  expect(oldRecord.col).toBeNull();
  await store.writeRecord(oldRecord);
  await refreshVerdicts(loaded, store);
  const refreshed = (await store.readRecords()).records.find(
    (record) => record.finding_id === first.finding_id,
  );
  expect(refreshed?.decision).toEqual(first.decision);
  const oldReport = buildReport([oldRecord], securityPriority);
  for (const rendered of [
    renderHuman(oldReport, securityPresentation, true),
    renderMarkdown(oldReport, securityPresentation),
  ]) {
    expect(rendered).toContain("src/routes/user.ts:5");
    expect(rendered).not.toContain("src/routes/user.ts:5:");
  }
  await syncRecords(store, output, false, loaded);
  expect(
    (await store.readRecords()).records.find((record) => record.finding_id === first.finding_id)
      ?.col,
  ).toBe(first.col);
});
