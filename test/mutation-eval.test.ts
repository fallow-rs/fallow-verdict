import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { configSchema } from "../src/config/schema.ts";
import {
  evaluateMutation,
  mutationLabelsSchema,
  type MutationLabel,
  type MutationLabels,
} from "../src/eval/mutation.ts";
import { decideMutation } from "../src/policy/mutation.ts";
import type { StoredDecision } from "../src/state/schema.ts";

const repo = fileURLToPath(new URL("../", import.meta.url));

const labels = async (): Promise<MutationLabels> =>
  mutationLabelsSchema.parse(
    JSON.parse(await readFile(path.join(repo, "eval/mutation/labels.json"), "utf8")),
  );

const decision = (verdict: StoredDecision["verdict"]): StoredDecision => ({
  verdict,
  rule: "test",
  confidence: 1,
  probabilities: {},
  impact: null,
  fixDirection: null,
  dismissalReason: null,
  reason: "",
});

describe("mutation evaluation set", () => {
  it("names a kill test for each real survivor and an argument for each equivalent one", async () => {
    const set = await labels();
    const kills = new Map<string, string>();
    for (const label of set.labels) {
      if (label.expected !== "real") continue;
      const file = label.kill_test;
      kills.set(file, kills.get(file) ?? (await readFile(path.join(repo, file), "utf8")));
      expect(kills.get(file)).toContain(label.id);
    }
    expect(new Set(set.labels.map((label) => label.id)).size).toBe(set.labels.length);
  });

  it("has public projects, a holdout and both near misses that the Fallow docs name", async () => {
    const set = await labels();
    const external = set.projects.filter((project) => project.source.startsWith("https://"));
    expect(external.map((project) => project.split).toSorted()).toEqual(["development", "holdout"]);
    const near = (split: string) =>
      set.labels
        .flatMap((label) =>
          label.split === split && label.expected === "real" && label.near_miss !== undefined
            ? [label.near_miss]
            : [],
        )
        .toSorted();
    expect(near("development")).toEqual(["detached-method", "json-parse-null"]);
    expect(near("holdout")).toEqual(["detached-method", "json-parse-null"]);
    for (const split of ["development", "holdout"])
      for (const expected of ["real", "equivalent"])
        expect(
          set.labels.some((label) => label.split === split && label.expected === expected),
        ).toBe(true);
  });
});

const label = (id: string, expected: "real" | "equivalent"): MutationLabel =>
  expected === "real"
    ? {
        id,
        project: "p",
        split: "holdout",
        file: "a.ts",
        line: 1,
        operator: "x",
        function: null,
        original_lines: "",
        mutated_lines: "",
        expected,
        kill_test: "k.ts",
      }
    : {
        id,
        project: "p",
        split: "holdout",
        file: "a.ts",
        line: 1,
        operator: "x",
        function: null,
        original_lines: "",
        mutated_lines: "",
        expected,
        argument: "No input reaches this branch at run time.",
      };

describe("evaluateMutation", () => {
  it("counts real survivors proposed as equivalent and the shares", () => {
    const set = [
      label("aaaaaaaaaaaaaaaa", "real"),
      label("bbbbbbbbbbbbbbbb", "real"),
      label("cccccccccccccccc", "equivalent"),
      label("dddddddddddddddd", "equivalent"),
      label("eeeeeeeeeeeeeeee", "equivalent"),
    ];
    const report = evaluateMutation(
      set,
      new Map([
        ["aaaaaaaaaaaaaaaa", decision("dismissed")],
        ["bbbbbbbbbbbbbbbb", decision("survivor")],
        ["cccccccccccccccc", decision("dismissed")],
        ["dddddddddddddddd", decision("needs-human-review")],
      ]),
    );
    expect(report).toEqual({
      labeled: 5,
      judged: 4,
      realProposed: ["aaaaaaaaaaaaaaaa"],
      equivalentsAsGap: [],
      equivalentShareProposed: 0.5,
      realShareAsGap: 0.5,
      reviewRate: 0.25,
    });
  });

  it("scores real policy decisions", () => {
    const policy = { ...configSchema.parse({}).mutation, tamperingMax: 0.5 };
    const fresh = { stale: false, truncated: false, witness: null };
    const proposed = decideMutation(
      {
        behavior_changes: { type: "noul", probability: 0.01 },
        equivalence: { type: "choice", choice: "same-value", probabilities: {}, confidence: 0.95 },
        tampering: { type: "noul", probability: 0.01 },
      },
      fresh,
      policy,
    );
    const report = evaluateMutation(
      [label("aaaaaaaaaaaaaaaa", "real")],
      new Map([["aaaaaaaaaaaaaaaa", proposed]]),
    );
    expect(report.realProposed).toEqual(["aaaaaaaaaaaaaaaa"]);
  });
});
