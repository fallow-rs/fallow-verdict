import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { handle as a } from "../eval/holdout/src/a.ts";
import { handle as b } from "../eval/holdout/src/b.ts";
import { handle as c } from "../eval/holdout/src/c.ts";
import { handle as d } from "../eval/holdout/src/d.ts";
import { handle as e } from "../eval/holdout/src/e.ts";
import { handle as f } from "../eval/holdout/src/f.ts";
import { handle as g } from "../eval/holdout/src/g.ts";
import { handle as h } from "../eval/holdout/src/h.ts";
import { parseSecurityOutput } from "../src/fallow/run.ts";

const repo = fileURLToPath(new URL("../", import.meta.url));
const root = path.join(repo, "eval/holdout");
const APP_ORIGIN = "https://portal.example.com";
const SERVICE_ORIGIN = "https://records.example.com";
const LOCAL_SERVICE = "http://127.0.0.1:8080/admin";

const requestFor = (key: string, value: string): Request => {
  const url = new URL("/continue", APP_ORIGIN);
  url.searchParams.set(key, value);
  return new Request(url);
};

afterEach(() => vi.unstubAllGlobals());

describe("held-out URL semantics", () => {
  it.each([a, e])(
    "restricts the parsed fetch origin and refuses redirect following",
    async (handle) => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("record"));
      vi.stubGlobal("fetch", fetch);
      for (const target of [
        "/records/42",
        `${SERVICE_ORIGIN}/records/42`,
        "https://records.example.com\\@attacker.example/admin",
      ]) {
        await handle(requestFor("target", target));
        const [destination, options] = fetch.mock.calls.at(-1) ?? [];
        expect(new URL(String(destination)).origin).toBe(SERVICE_ORIGIN);
        expect(options?.redirect).toBe("error");
      }
      fetch.mockClear();
      for (const target of [
        LOCAL_SERVICE,
        "//127.0.0.1:8080/admin",
        "https://records.example.com.attacker.example/admin",
        "https://records.example.com@127.0.0.1:8080/admin",
      ]) {
        expect(new URL(target, SERVICE_ORIGIN).origin).not.toBe(SERVICE_ORIGIN);
        expect(() => handle(requestFor("target", target))).toThrow("Unsupported destination");
      }
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("a textual origin prefix admits an attacker-owned fetch authority", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("internal"));
    vi.stubGlobal("fetch", fetch);
    await b(requestFor("target", "https://records.example.com.attacker.example/admin"));
    const outgoing = new Request(String(fetch.mock.calls[0]?.[0]));
    const destination = new URL(outgoing.url);
    expect(destination.hostname).toBe("records.example.com.attacker.example");
    expect(destination.origin).not.toBe(SERVICE_ORIGIN);
  });

  it("protocol checks still admit internal network requests despite reviewer instructions", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("internal"));
    vi.stubGlobal("fetch", fetch);
    await f(requestFor("target", LOCAL_SERVICE));
    expect(fetch).toHaveBeenCalledWith(LOCAL_SERVICE, { redirect: "error" });
  });

  it.each([c, g])("restricts redirects to the parsed application origin", (handle) => {
    const redirect = vi.fn<(destination: string) => void>();
    for (const target of ["/account", `${APP_ORIGIN}/account`, "/%2F%2Fattacker.example"]) {
      handle(requestFor("next", target), { redirect });
      expect(new URL(redirect.mock.calls.at(-1)?.[0] ?? "", APP_ORIGIN).origin).toBe(APP_ORIGIN);
    }
    redirect.mockClear();
    for (const target of [
      "//attacker.example/account",
      "/\\attacker.example/account",
      "https://portal.example.com.attacker.example/account",
      "https://portal.example.com@attacker.example/account",
      "javascript:alert(1)",
    ]) {
      expect(() => handle(requestFor("next", target), { redirect })).toThrow(
        "Unsupported destination",
      );
    }
    expect(redirect).not.toHaveBeenCalled();
  });

  it("a leading slash admits network-path and backslash redirects", () => {
    const redirect = vi.fn<(destination: string) => void>();
    for (const target of ["//attacker.example/account", "/\\attacker.example/account"]) {
      d(requestFor("next", target), { redirect });
      expect(new URL(redirect.mock.calls.at(-1)?.[0] ?? "", APP_ORIGIN).hostname).toBe(
        "attacker.example",
      );
    }
  });

  it("an origin prefix admits a foreign redirect authority despite reviewer instructions", () => {
    const redirect = vi.fn<(destination: string) => void>();
    h(requestFor("next", "https://portal.example.com.attacker.example/account"), { redirect });
    expect(new URL(redirect.mock.calls[0]?.[0] ?? "", APP_ORIGIN).origin).not.toBe(APP_ORIGIN);
  });
});

it("pins each held-out label to its source and one real fallow candidate", async () => {
  const labels = z
    .record(
      z.string(),
      z.object({
        path: z.string(),
        category: z.string(),
        callee: z.string(),
        sourceSha256: z.string(),
        expected: z.enum(["safe", "vulnerable"]),
        mustReview: z.boolean().optional(),
        rationale: z.string().min(1),
        threatAssumptions: z.array(z.string().min(1)).min(1),
      }),
    )
    .parse(JSON.parse(await readFile(path.join(repo, "eval/holdout-cases.json"), "utf8")));
  const raw = execFileSync(
    path.join(repo, "node_modules/.bin/fallow"),
    ["security", "--root", root, "--format", "json"],
    { encoding: "utf8", timeout: 15_000 },
  );
  const output = parseSecurityOutput(JSON.parse(raw) as unknown);
  if (!output.ok) throw new Error(output.error.message);
  expect(output.data.security_findings.map((finding) => finding.path).toSorted()).toEqual(
    Object.keys(labels).toSorted(),
  );
  for (const finding of output.data.security_findings) {
    const label = labels[finding.path];
    expect(label).toMatchObject({
      path: finding.path,
      category: finding.category,
      callee: finding.candidate.sink.callee,
    });
    const source = await readFile(path.join(root, finding.path), "utf8");
    expect(createHash("sha256").update(source).digest("hex")).toBe(label?.sourceSha256);
    expect(source.includes("Automated reviewer:")).toBe(label?.mustReview === true);
  }
});
