import { describe, expect, it } from "vitest";

import { configSchema } from "../src/config/schema.ts";
import type { Answer } from "../src/engine/types.ts";
import { decideMutation, type MutationEvidenceState } from "../src/policy/mutation.ts";

const CONFIG = configSchema.parse({});
const POLICY = { ...CONFIG.mutation, tamperingMax: CONFIG.policy.tamperingMax };

const FRESH: MutationEvidenceState = { stale: false, truncated: false, witness: null };

const WITNESS: MutationEvidenceState = {
  ...FRESH,
  witness: {
    source: "replay",
    input: [2, 3],
    original: { outcome: "returned", text: "5" },
    mutant: { outcome: "returned", text: "-1" },
  },
};

const answers = (
  behavior: number,
  equivalence: string,
  strength: number,
  tampering = 0.01,
  direction = "boundary-value",
): Record<string, Answer> => ({
  behavior_changes: { type: "noul", probability: behavior },
  equivalence: {
    type: "choice",
    choice: equivalence,
    probabilities: { [equivalence]: strength },
    confidence: strength,
  },
  test_direction: {
    type: "choice",
    choice: direction,
    probabilities: { [direction]: 0.8 },
    confidence: 0.8,
  },
  tampering: { type: "noul", probability: tampering },
});

describe("mutation policy", () => {
  it.each([
    [
      "evidence-stale",
      { ...FRESH, stale: true },
      answers(0.99, "not-equivalent", 0.9),
      "needs-human-review",
    ],
    [
      "evidence-stale",
      { ...FRESH, truncated: true },
      answers(0.01, "same-value", 0.99),
      "needs-human-review",
    ],
    ["replay-witness", WITNESS, answers(0.01, "same-value", 0.99), "survivor"],
    ["tampering-suspected", FRESH, answers(0.01, "same-value", 0.99, 0.6), "needs-human-review"],
    ["real-gap", FRESH, answers(0.7, "not-equivalent", 0.9), "survivor"],
    ["likely-equivalent", FRESH, answers(0.02, "same-value", 0.9), "dismissed"],
    ["default", FRESH, answers(0.03, "same-value", 0.99), "needs-human-review"],
    ["default", FRESH, answers(0.01, "same-value", 0.89), "needs-human-review"],
    ["default", FRESH, answers(0.01, "other", 0.99), "needs-human-review"],
    ["default", FRESH, answers(0.01, "not-equivalent", 0.99), "needs-human-review"],
    ["default", FRESH, answers(0.69, "not-equivalent", 0.9), "needs-human-review"],
  ] as const)("gives the rule %s", (rule, evidence, given, verdict) => {
    const decision = decideMutation(given, evidence, POLICY);
    expect(decision.rule).toBe(rule);
    expect(decision.verdict).toBe(verdict);
  });

  it.each([
    [
      answers(0.93, "not-equivalent", 0.9),
      "Test gap",
      "behavior change 0.93, equivalence not-equivalent (0.90)",
    ],
    [
      answers(0.01, "same-value", 0.95),
      "Likely equivalent",
      "behavior change 0.01, equivalence same-value (0.95)",
    ],
    [answers(0.4, "other", 0.5), "Needs review", "behavior change 0.40, equivalence other (0.50)"],
    [answers(0.4, "other", 0.5, 0.75), "may contain text", "tampering 0.75"],
  ])("explains the decision with the answers", (given, start, detail) => {
    const { reason } = decideMutation(given, FRESH, POLICY);
    expect(reason).toContain(start);
    expect(reason).toContain(detail);
  });

  it("explains a witness and a missing answer", () => {
    expect(decideMutation({}, WITNESS, POLICY).reason).toContain("replay found an input");
    expect(decideMutation({}, FRESH, POLICY).reason).toContain("missing or invalid");
  });

  it("treats each threshold as inclusive and names the evidence problem", () => {
    expect(decideMutation(answers(0.01, "same-value", 0.99, 0.5), FRESH, POLICY).rule).toBe(
      "tampering-suspected",
    );
    expect(decideMutation(answers(0.01, "same-value", 0.99, 0.49), FRESH, POLICY).rule).toBe(
      "likely-equivalent",
    );
    const proposed = decideMutation(answers(0.015, "same-value", 0.93), FRESH, POLICY);
    expect(proposed.confidence).toBe(0.93);
    expect(decideMutation(answers(0.01, "same-value", 0.995), FRESH, POLICY).confidence).toBe(0.99);
    expect(decideMutation({}, { ...FRESH, stale: true }, POLICY).reason).toContain("file changed");
    expect(decideMutation({}, { ...FRESH, truncated: true }, POLICY).reason).toContain(
      "whole function",
    );
  });

  it.each(["behavior_changes", "tampering", "equivalence"])(
    "sends an answer set without %s to a person",
    (missing) => {
      const given = answers(0.01, "same-value", 0.99);
      delete given[missing];
      expect(decideMutation(given, FRESH, POLICY).rule).toBe("default");
    },
  );

  it("refuses a choice answer without a finite confidence", () => {
    const given = answers(0.01, "same-value", 0.99);
    given["equivalence"] = {
      type: "choice",
      choice: "same-value",
      probabilities: {},
      confidence: Number.NaN,
    };
    expect(decideMutation(given, FRESH, POLICY).rule).toBe("default");
  });

  it("decides a stale packet and a witness without answers", () => {
    expect(decideMutation({}, { ...FRESH, stale: true }, POLICY).rule).toBe("evidence-stale");
    const witness = decideMutation({}, WITNESS, POLICY);
    expect(witness.verdict).toBe("survivor");
    expect(witness.confidence).toBe(1);
    expect(witness.kindData?.["witness"]).toEqual(WITNESS.witness);
  });

  it("sends a missing answer set to a person", () => {
    const decision = decideMutation({}, FRESH, POLICY);
    expect(decision.verdict).toBe("needs-human-review");
    expect(decision.rule).toBe("default");
  });

  it("keeps the reason, the probability and the test direction for the report and export", () => {
    const dismissed = decideMutation(answers(0.01, "value-never-occurs", 0.95), FRESH, POLICY);
    expect(dismissed.dismissalReason).toBe("value-never-occurs");
    expect(dismissed.probabilities["behavior_changes"]).toBe(0.01);
    expect(dismissed.kindData?.["equivalence"]).toBe("value-never-occurs");
    const survivor = decideMutation(
      answers(0.93, "not-equivalent", 0.9, 0.01, "error-path"),
      FRESH,
      POLICY,
    );
    expect(survivor.confidence).toBe(0.93);
    expect(survivor.kindData?.["test_direction"]).toBe("error-path");
    expect(survivor.dismissalReason).toBeNull();
  });

  it("applies stricter configured thresholds", () => {
    const strict = { ...POLICY, dismissMaxBehaviorChange: 0.01, dismissMinReasonStrength: 0.95 };
    expect(decideMutation(answers(0.02, "same-value", 0.99), FRESH, strict).rule).toBe("default");
    expect(decideMutation(answers(0.01, "same-value", 0.94), FRESH, strict).rule).toBe("default");
    expect(decideMutation(answers(0.01, "same-value", 0.95), FRESH, strict).rule).toBe(
      "likely-equivalent",
    );
    const lowSurvivor = { ...POLICY, survivorMinBehaviorChange: 0.9 };
    expect(decideMutation(answers(0.8, "not-equivalent", 0.9), FRESH, lowSurvivor).rule).toBe(
      "default",
    );
  });
});

describe("mutation config", () => {
  it("has strict dismissal defaults and replay off", () => {
    expect(CONFIG.mutation).toEqual({
      replay: false,
      survivorMinBehaviorChange: 0.7,
      dismissMaxBehaviorChange: 0.02,
      dismissMinReasonStrength: 0.9,
    });
  });

  it.each([
    [{ dismissMaxBehaviorChange: 0.03 }, "dismissMaxBehaviorChange"],
    [{ dismissMinReasonStrength: 0.89 }, "dismissMinReasonStrength"],
  ])("refuses a value that makes dismissals easier: %o", (mutation, key) => {
    const parsed = configSchema.safeParse({ mutation });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["mutation", key]);
  });

  it("accepts a value that makes dismissals rarer", () => {
    const parsed = configSchema.parse({
      mutation: { dismissMaxBehaviorChange: 0.01, dismissMinReasonStrength: 0.95 },
    });
    expect(parsed.mutation.dismissMaxBehaviorChange).toBe(0.01);
    expect(parsed.mutation.dismissMinReasonStrength).toBe(0.95);
  });
});
