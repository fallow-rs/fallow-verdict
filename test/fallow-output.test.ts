import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { expect, it } from "vitest";

import { parseSecurityOutput, runSecurityScan } from "../src/fallow/run.ts";
import type { SecurityOutput } from "../src/fallow/types.ts";
import { judge } from "../src/pipeline/judge.ts";
import { scan, syncRecords } from "../src/pipeline/scan.ts";
import { openStore } from "../src/state/store.ts";
import {
  makeFinding,
  makeLoaded,
  makeOutput,
  makeProject,
  mockEngine,
  SAFE_MITIGATED,
} from "./helpers.ts";

const duplicateOutput = (): SecurityOutput =>
  makeOutput([
    makeFinding(),
    makeFinding({
      col: 99,
      candidate: { ...makeFinding().candidate, sink: { ...makeFinding().candidate.sink, col: 99 } },
    }),
  ]);

it("rejects ambiguous finding identities even when their source columns differ", () => {
  expect(parseSecurityOutput(duplicateOutput())).toMatchObject({
    ok: false,
    error: { code: "fallow_output_invalid" },
  });
});

it.each([undefined, null, "", "   ", 3])("rejects missing or invalid identities", (id) => {
  expect(
    parseSecurityOutput({
      ...makeOutput([]),
      security_findings: [{ ...makeFinding(), finding_id: id }],
    }),
  ).toMatchObject({
    ok: false,
    error: { code: "fallow_output_invalid" },
  });
});

it("rejects stored ambiguous candidates before making an engine request", async () => {
  const loaded = makeLoaded(await makeProject());
  const store = openStore(loaded.dataDir);
  const output = duplicateOutput();
  await store.writeJson(store.candidatesPath, output);
  await syncRecords(store, makeOutput([makeFinding()]), false, loaded);
  const before = await store.readRecords();
  const engine = mockEngine(() => SAFE_MITIGATED);
  expect(await judge(loaded, store, engine, { rejudge: false, dryRun: false })).toMatchObject({
    ok: false,
    error: { code: "fallow_output_invalid" },
  });
  expect(engine.calls).toBe(0);
  expect(await store.readRecords()).toEqual(before);
});

it("checks uniqueness within the selected scope and preserves prior state on scan failure", async () => {
  const root = await makeProject();
  const binary = path.join(root, "fallow-test.mjs");
  const output = duplicateOutput();
  output.security_findings.push(makeFinding({ finding_id: "other", path: "other/safe.ts" }));
  await writeFile(
    binary,
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(output))});\n`,
    { mode: 0o755 },
  );
  const loaded = makeLoaded(root);
  loaded.config.fallow.binary = binary;
  const store = openStore(loaded.dataDir);
  const prior = makeOutput([makeFinding({ finding_id: "previous" })]);
  await store.writeJson(store.candidatesPath, prior);
  await syncRecords(store, prior, false, loaded);
  const before = await store.readRecords();
  expect(await scan(loaded, store, {})).toMatchObject({
    ok: false,
    error: { code: "fallow_output_invalid" },
  });
  expect(JSON.parse(await readFile(store.candidatesPath, "utf8"))).toEqual(prior);
  expect(await store.readRecords()).toEqual(before);
  expect(await runSecurityScan({ root, binary, paths: ["other"] })).toMatchObject({
    ok: true,
    data: { security_findings: [{ finding_id: "other" }] },
  });
  expect(await runSecurityScan({ root, binary, paths: ["src"] })).toMatchObject({
    ok: false,
    error: { code: "fallow_output_invalid" },
  });
});
