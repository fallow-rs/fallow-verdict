import { describe, expect, it } from "vitest";

import { policySchema } from "../src/config/schema.ts";
import { buildPacket } from "../src/packet/build.ts";
import { decide } from "../src/policy/decide.ts";
import {
  answersFor,
  makeFinding,
  makeOutput,
  makeProject,
  SAFE_MITIGATED,
  SINK_FILE,
  VULNERABLE,
} from "./helpers.ts";

const policy = policySchema.parse({});
const packetOptions = { radius: 20, maxStateTokens: 28_000, blind: false };

const built = async (overrides = {}, files?: Record<string, string>) => {
  const finding = makeFinding(overrides);
  const root = await makeProject(files);
  return buildPacket(finding, makeOutput([finding]), { root, ...packetOptions });
};

describe("decide", () => {
  it("calls a candidate a survivor when exploitability and evidence agree", async () => {
    const decision = decide(answersFor(VULNERABLE), await built(), policy);
    expect(decision.verdict).toBe("survivor");
    expect(decision.confidence).toBeCloseTo(0.94);
    expect(decision.impact?.label).toBe("critical");
    expect(decision.fixDirection).toBe("avoid-shell");
  });

  it("dismisses with a named reason when exploitability is low", async () => {
    const decision = decide(
      answersFor(SAFE_MITIGATED),
      await built({ severity: "medium" }),
      policy,
    );
    expect(decision.verdict).toBe("dismissed");
    expect(decision.dismissalReason).toBe("mitigated");
    expect(decision.impact).toBeNull();
  });

  it("holds high-severity candidates to a stricter dismissal bar than medium", async () => {
    const borderline = answersFor({ ...SAFE_MITIGATED, exploitable: 0.08 });
    expect(decide(borderline, await built({ severity: "medium" }), policy).verdict).toBe(
      "dismissed",
    );
    expect(decide(borderline, await built({ severity: "high" }), policy).verdict).toBe(
      "needs-human-review",
    );
  });

  it("does not dismiss on low exploitability alone, without a named reason", async () => {
    const vague = answersFor({
      ...SAFE_MITIGATED,
      mitigated: 0.5,
      attacker_controlled: 0.5,
      reaches_sink: 0.5,
    });
    const decision = decide(vague, await built({ severity: "low" }), policy);
    expect(decision).toMatchObject({ verdict: "needs-human-review", rule: "uncertain" });
  });

  it("sends a candidate to a human when the code argues for its own safety", async () => {
    const decision = decide(
      answersFor({ ...SAFE_MITIGATED, tampering: 0.8 }),
      await built(),
      policy,
    );
    expect(decision).toMatchObject({ verdict: "needs-human-review", rule: "tampering-suspected" });
  });

  it("refuses to dismiss on truncated evidence", async () => {
    const packet = { ...(await built({ severity: "low" })), truncated: true };
    expect(decide(answersFor(SAFE_MITIGATED), packet, policy)).toMatchObject({
      verdict: "needs-human-review",
      rule: "truncated-evidence",
    });
  });

  it("flags a conflict when exploitability is high but the evidence answers disagree", async () => {
    const decision = decide(
      answersFor({ ...VULNERABLE, reaches_sink: 0.2 }),
      await built(),
      policy,
    );
    expect(decision).toMatchObject({ verdict: "needs-human-review", rule: "evidence-conflict" });
  });

  it("never decides without the sink source", async () => {
    const packet = await built({}, { "src/other.ts": "export {};\n" });
    expect(packet.unreadable).toContain(SINK_FILE);
    expect(decide(answersFor(SAFE_MITIGATED), packet, policy)).toMatchObject({
      verdict: "needs-human-review",
      rule: "evidence-missing",
    });
  });

  it("prefers deleting dead code over hardening it", async () => {
    const packet = await built({
      dead_code: { kind: "unused-file", guidance: "Verify, then delete the file." },
    });
    expect(decide(answersFor(VULNERABLE), packet, policy).fixDirection).toBe("delete-dead-code");
  });
});
