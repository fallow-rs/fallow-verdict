import { describe, expect, it } from "vitest";

import type { FindingRecord, StoredDecision } from "../src/state/schema.ts";
import { toMutationProposals } from "../src/verdicts/mutation.ts";

const decision = (overrides: Partial<StoredDecision> = {}): StoredDecision => ({
  verdict: "dismissed",
  rule: "likely-equivalent",
  confidence: 0.95,
  probabilities: { behavior_changes: 0.01, tampering: 0.02, "equivalence:same-value": 0.97 },
  impact: null,
  fixDirection: null,
  dismissalReason: "same-value",
  reason: "Likely equivalent.",
  ...overrides,
});

const record = (id: string, overrides: Partial<FindingRecord> = {}): FindingRecord => ({
  schema_version: "fallow-verdict-record/v1",
  kind: "mutation",
  finding_id: id,
  path: "src/a.ts",
  line: 1,
  col: 0,
  category: "relational-operator",
  severity: null,
  status: "judged",
  firstSeenAt: "2026-11-25T00:00:00.000Z",
  lastSeenAt: "2026-11-25T00:00:00.000Z",
  fingerprint: "f",
  questionSet: "mutation-1",
  questionHash: "h",
  engine: "e",
  answers: {},
  decision: decision(),
  evidence: null,
  usage: null,
  error: null,
  history: [
    {
      at: "0",
      runId: "run-first",
      verdict: "survivor",
      rule: "real-gap",
      confidence: 0.8,
      fingerprint: "f",
      model: "m",
    },
    {
      at: "a",
      runId: "run-old",
      verdict: "survivor",
      rule: "real-gap",
      confidence: 0.8,
      fingerprint: "f",
      model: "m",
    },
    {
      at: "b",
      runId: "run-new",
      verdict: "dismissed",
      rule: "likely-equivalent",
      confidence: 0.95,
      fingerprint: "f",
      model: "m",
    },
  ],
  ...overrides,
});

describe("toMutationProposals", () => {
  it("proposes only a current, judged, unclosed likely-equivalent dismissal", () => {
    const ids = new Set([
      "a000000000000001",
      "a000000000000002",
      "a000000000000003",
      "a000000000000004",
      "a000000000000005",
      "a000000000000006",
    ]);
    const proposals = toMutationProposals(
      [
        record("a000000000000006"),
        record("a000000000000001"),
        record("a000000000000002", { closed: { at: "c", reason: "accepted", fingerprint: "f" } }),
        record("a000000000000003", { status: "pending" }),
        record("a000000000000004", {
          decision: decision({ verdict: "needs-human-review", rule: "dismissal-unconfirmed" }),
        }),
        record("a000000000000005", {
          decision: decision({ verdict: "survivor", rule: "real-gap" }),
        }),
        record("b000000000000009"),
      ],
      ids,
    );
    expect(proposals).toEqual({
      schema_version: "1",
      verdicts: [
        {
          review_key: "a000000000000001",
          verdict: "equivalent",
          note: "Proposed by fallow-verdict, not reviewed: equivalence same-value (0.97), P(behavior_changes) 0.01, decision likely-equivalent in run run-new.",
        },
        {
          review_key: "a000000000000006",
          verdict: "equivalent",
          note: "Proposed by fallow-verdict, not reviewed: equivalence same-value (0.97), P(behavior_changes) 0.01, decision likely-equivalent in run run-new.",
        },
      ],
    });
  });

  it("writes a note without control characters and with unknown parts named", () => {
    const proposals = toMutationProposals(
      [
        record("a000000000000001", {
          decision: decision({ dismissalReason: "same-value\n\tx", probabilities: {} }),
          history: [],
        }),
      ],
      new Set(["a000000000000001"]),
    );
    expect(proposals.verdicts[0]?.note).toBe(
      "Proposed by fallow-verdict, not reviewed: equivalence same-value x, P(behavior_changes) unknown, decision likely-equivalent in run unknown.",
    );
  });
});
