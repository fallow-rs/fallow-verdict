import { describe, expect, it } from "vitest";

import { parseCli } from "../src/cli/args.ts";
import { judge } from "../src/pipeline/judge.ts";
import { syncRecords } from "../src/pipeline/scan.ts";
import { questionHash, questionsForProfile } from "../src/questions/category.ts";
import { QUESTIONS } from "../src/questions/catalog.ts";
import { buildReport, renderHuman, renderMarkdown } from "../src/report/render.ts";
import { openStore } from "../src/state/store.ts";
import {
  makeFinding,
  makeLoaded,
  makeOutput,
  makeProject,
  mockEngine,
  SAFE_MITIGATED,
} from "./helpers.ts";

const options = { rejudge: false, dryRun: false };

describe("question profiles", () => {
  it("requires explicit opt-in and preserves generic questions for blind or unsupported categories", () => {
    expect(questionsForProfile({ category: "ssrf" }, "generic")).toEqual(QUESTIONS);
    expect(questionsForProfile({ category: null }, "category")).toEqual(QUESTIONS);
    expect(questionsForProfile({ category: "sql-injection" }, "category")).toEqual(QUESTIONS);
    expect(questionHash({ category: "ssrf" }, "category")).not.toBe(
      questionHash({ category: "ssrf" }, "generic"),
    );
    expect(parseCli(["run", "--question-profile", "category"])).toMatchObject({
      ok: true,
      data: { options: { questionProfile: "category" } },
    });
    expect(parseCli(["run", "--question-profile", "invalid"]).ok).toBe(false);
  });

  it("rejudges changed question content and rejects stale question hashes before budget stops", async () => {
    const root = await makeProject();
    const loaded = makeLoaded(root);
    const store = openStore(loaded.dataDir);
    const output = makeOutput([makeFinding({ category: "ssrf" })]);
    await store.writeJson(store.candidatesPath, output);
    await syncRecords(store, output, false);
    const engine = mockEngine(() => SAFE_MITIGATED);
    await judge(loaded, store, engine, options);
    const category = makeLoaded(root, { questionProfile: "category" });
    await judge(category, store, engine, options);
    await judge(category, store, engine, options);
    expect(engine.calls).toBe(2);
    const record = (await store.readRecords()).records[0];
    if (record === undefined) throw new Error("Missing record");
    await store.writeRecord({ ...record, questionHash: "old-unversioned-questions" });
    await judge(category, store, engine, { ...options, limit: 0 });
    expect((await store.readRecords()).records[0]).toMatchObject({
      status: "pending",
      decision: null,
    });
  });
});

it("shows reasons for decisions and incomplete findings in human and Markdown reports", async () => {
  const root = await makeProject();
  const loaded = makeLoaded(root);
  const store = openStore(loaded.dataDir);
  const output = makeOutput([makeFinding()]);
  await store.writeJson(store.candidatesPath, output);
  await syncRecords(store, output, false);
  await judge(
    loaded,
    store,
    mockEngine(() => SAFE_MITIGATED),
    options,
  );
  const record = (await store.readRecords()).records[0];
  if (record === undefined || record.decision === null) throw new Error("Missing decision");
  const report = buildReport([
    record,
    { ...record, finding_id: "pending", path: "src/pending.ts", status: "pending", decision: null },
    {
      ...record,
      finding_id: "error",
      path: "src/error.ts",
      status: "error",
      decision: null,
      error: { code: "engine_timeout", message: "provider | timed out" },
    },
  ]);
  const human = renderHuman(report, true);
  const markdown = renderMarkdown(report);
  expect(human).toContain("Jev considers the protection in the supplied code effective");
  expect(human).toContain("Model estimate of exploitability:");
  expect(markdown).toContain(record.decision.reason);
  expect(human).toContain("src/pending.ts");
  expect(human).toContain("engine_timeout");
  expect(markdown).toContain("provider \\| timed out");
  expect(markdown).toContain("No current assessment");
  expect(markdown).toContain("<summary>Assessment details</summary>");

  const saved = structuredClone(report);
  const before = structuredClone(saved);
  renderHuman(saved, false);
  renderMarkdown(saved);
  expect(saved).toEqual(before);

  const unusual = buildReport([
    {
      ...record,
      path: "src/[sample]<script>.ts",
      decision: {
        ...record.decision,
        probabilities: {},
        rule: "future-rule",
        reason: "Review <script>\n# injected heading",
      },
    },
  ]);
  expect(renderHuman(unusual, true)).toContain("exploitability: unavailable");
  expect(renderMarkdown(unusual)).toContain("src/\\[sample\\]\\<script\\>.ts");
  expect(renderMarkdown(unusual)).not.toContain("\n# injected heading");
  expect(renderHuman(buildReport([]), false)).toContain("No active candidates");
});
