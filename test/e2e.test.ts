import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

import { recordSchema } from "../src/state/schema.ts";
import { openStore } from "../src/state/store.ts";

const repo = fileURLToPath(new URL("../", import.meta.url));
const cli = path.join(repo, "bin/fallow-verdict.js");

const runCli = (root: string, args: string[]): Promise<{ code: number; data: unknown }> =>
  new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [cli, ...args, "--cwd", root, "--format", "json"],
      {
        env: { ...process.env, TYPESAFE_API_KEY: "contract-test-key" },
      },
      (error, stdout) => {
        if (error !== null && typeof error.code !== "number") return reject(error);
        let data: unknown;
        try {
          data = JSON.parse(stdout) as unknown;
        } catch (cause) {
          return reject(cause);
        }
        resolve({ code: typeof error?.code === "number" ? error.code : 0, data });
      },
    );
  });

it("runs the built CLI with real fallow, resumes, rejects stale verdicts and exposes provider failures", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "verdict-e2e-"));
  let calls = 0;
  let rejectRequests = false;
  const server = createServer((request, response) => {
    calls += 1;
    request.resume();
    response.setHeader("content-type", "application/json");
    if (rejectRequests) {
      response.writeHead(422).end(JSON.stringify({ error: "invalid request" }));
      return;
    }
    response.end(
      JSON.stringify({
        model: "contract-test-model",
        answers: {
          attacker_controlled: { type: "noul", noul: 0.1 },
          reaches_sink: { type: "noul", noul: 0.2 },
          mitigated: { type: "noul", noul: 0.99 },
          exploitable: { type: "noul", noul: 0.01 },
          non_production: { type: "noul", noul: 0.01 },
          tampering: { type: "noul", noul: 0.01 },
          impact: {
            type: "score",
            score: 0,
            probabilities: { "0": 1, "1": 0, "2": 0, "3": 0 },
            confidence: 1,
          },
          fix_direction: {
            type: "choice",
            choice: "none",
            probabilities: { none: 1 },
            confidence: 1,
          },
        },
        usage: { input_tokens: 1000 },
      }),
    );
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing server address");
    await cp(path.join(repo, "eval/corpus/src"), path.join(root, "src"), { recursive: true });
    await cp(path.join(repo, "eval/corpus/package.json"), path.join(root, "package.json"));
    await writeFile(
      path.join(root, "fallow-verdict.config.json"),
      JSON.stringify({
        fallow: { binary: path.join(repo, "node_modules/.bin/fallow") },
        engine: { baseUrl: `http://127.0.0.1:${address.port}/v1` },
      }),
    );

    const first = await runCli(root, ["run"]);
    expect(first).toMatchObject({ code: 0, data: { summary: { pending: 0, errors: 0 } } });
    expect(calls).toBeGreaterThan(0);
    const initialCalls = calls;
    expect(await runCli(root, ["run"])).toMatchObject({ code: 0 });
    expect(calls).toBe(initialCalls);

    const source = path.join(root, "src/lookup.ts");
    await writeFile(source, `${await readFile(source, "utf8")}\n// Revision marker.\n`);
    expect(await runCli(root, ["report"])).toMatchObject({
      code: 2,
      data: { summary: { pending: 1 } },
    });
    const store = openStore(path.join(root, ".fallow-verdict"));
    const changed = (await store.readRecords()).records.find(
      (record) => record.path === "src/lookup.ts",
    );
    expect(recordSchema.parse(changed)).toMatchObject({ status: "pending", decision: null });
    expect(calls).toBe(initialCalls);

    rejectRequests = true;
    expect(await runCli(root, ["judge"])).toMatchObject({ code: 2, data: { error: true } });
    expect(await runCli(root, ["report", "--fail-on", "off"])).toMatchObject({ code: 2 });
    rejectRequests = false;
    expect(await runCli(root, ["judge"])).toMatchObject({ code: 0 });
    expect(await runCli(root, ["report"])).toMatchObject({ code: 0 });
    expect(await runCli(root, ["run", "src/lookup.ts", "src/profile.ts"])).toMatchObject({
      code: 0,
      data: { summary: { candidates: 2, dismissed: 2, pending: 0 } },
    });
    expect(await runCli(root, ["run", "src", "other"])).toMatchObject({
      code: 0,
      data: { summary: { candidates: initialCalls, dismissed: initialCalls, pending: 0 } },
    });
    await rm(path.join(root, ".fallow-verdict/findings"), { recursive: true });
    expect(await runCli(root, ["report"])).toMatchObject({
      code: 2,
      data: { code: "state_corrupt" },
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
