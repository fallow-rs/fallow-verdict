import { execFile } from "node:child_process";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseCli } from "../src/cli/args.ts";
import { ANALYSIS_KINDS, DEFAULT_KIND, parseKind } from "../src/kinds/names.ts";
import { kindFor } from "../src/kinds/registry.ts";
import { judge } from "../src/pipeline/judge.ts";
import { syncRecords } from "../src/pipeline/scan.ts";
import { recordSchema } from "../src/state/schema.ts";
import { openStore } from "../src/state/store.ts";
import {
  makeFinding,
  makeLoaded,
  makeOutput,
  makeProject,
  mockEngine,
  VULNERABLE,
} from "./helpers.ts";

const cli = fileURLToPath(new URL("../bin/fallow-verdict.js", import.meta.url));

const runCli = (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    execFile(process.execPath, [cli, ...args], (error, stdout, stderr) => {
      if (error !== null && typeof error.code !== "number") return reject(error);
      resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
    });
  });

describe("analysis kind registry", () => {
  it("has security as a kind and the default kind", () => {
    expect(ANALYSIS_KINDS).toContain("security");
    expect(DEFAULT_KIND).toBe("security");
  });

  it("resolves every known kind to an adapter for that kind", () => {
    for (const kind of ANALYSIS_KINDS) {
      expect(kindFor(kind).use((adapter) => adapter.kind)).toBe(kind);
    }
  });

  it("rejects an unknown kind and lists the known kinds", () => {
    const parsed = parseKind("dead-code");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.code).toBe("config_invalid");
    expect(parsed.error.message).toContain("dead-code");
    expect(parsed.error.message).toContain("security");
  });
});

describe("--kind", () => {
  it("defaults to security", () => {
    const parsed = parseCli(["scan"]);
    expect(parsed.ok && parsed.data.kind === "command" && parsed.data.options.analysisKind).toBe(
      "security",
    );
  });

  it.each(["scan", "judge", "run", "report", "status"])("accepts security for %s", (command) => {
    const parsed = parseCli([command, "--kind", "security"]);
    expect(parsed.ok && parsed.data.kind === "command" && parsed.data.options.analysisKind).toBe(
      "security",
    );
  });

  it("exits 2 for an unknown kind and lists the known kinds", async () => {
    const result = await runCli(["run", "--dry-run", "--kind", "dead-code"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("dead-code");
    expect(result.stderr).toContain("Known kinds: security, review, similar-code");
  });
});

describe("finding records", () => {
  it("stores the analysis kind on new records", async () => {
    const root = await makeProject();
    const loaded = makeLoaded(root);
    const store = openStore(loaded.dataDir, "security");
    const output = makeOutput([makeFinding()]);
    await store.writeJson(store.candidatesPath, output);
    await syncRecords(store, output, false);

    const { records } = await store.readRecords();
    expect(records.map((record) => record.kind)).toEqual(["security"]);
  });

  it("loads a record without a kind as a security record and judges it", async () => {
    const root = await makeProject();
    const loaded = makeLoaded(root);
    const store = openStore(loaded.dataDir, "security");
    const finding = makeFinding();
    const output = makeOutput([finding]);
    await store.writeJson(store.candidatesPath, output);
    await syncRecords(store, output, false);
    const [written] = (await store.readRecords()).records;
    if (written === undefined) throw new Error("Missing record");
    const { kind: _kind, ...legacy } = written;
    const findingsDir = path.join(loaded.dataDir, "findings");
    const [name] = await readdir(findingsDir);
    if (name === undefined) throw new Error("Missing record file");
    await writeFile(path.join(findingsDir, name), JSON.stringify(legacy));

    expect(recordSchema.parse(legacy).kind).toBe("security");
    const { records, corrupt } = await store.readRecords();
    expect(corrupt).toEqual([]);
    expect(records.map((record) => record.kind)).toEqual(["security"]);

    const engine = mockEngine(() => VULNERABLE);
    const summary = await judge(loaded, store, engine, { rejudge: false, dryRun: false });
    expect(summary).toMatchObject({ ok: true, data: { judged: 1, errors: 0 } });
  });
});
