import { describe, expect, it } from "vitest";

import { buildReport, renderHuman, renderMarkdown } from "../src/report/render.ts";
import type { FindingRecord, StoredDecision } from "../src/state/schema.ts";

const reviewRecord = (overrides: Partial<StoredDecision> = {}): FindingRecord => ({
  schema_version: "fallow-verdict-record/v1",
  finding_id: "review-candidate",
  path: "src/proxy.ts",
  line: 4,
  col: null,
  category: "ssrf",
  severity: "high",
  status: "judged",
  firstSeenAt: "2026-09-22T00:00:00.000Z",
  lastSeenAt: "2026-09-22T00:00:00.000Z",
  fingerprint: null,
  questionSet: null,
  questionHash: null,
  engine: null,
  answers: null,
  decision: {
    verdict: "needs-human-review",
    rule: "tampering-suspected",
    confidence: 0.95,
    probabilities: { exploitable: 0.95, tampering: 0.8 },
    impact: null,
    fixDirection: null,
    dismissalReason: null,
    reason: "The code contains text that argues for its own assessment.",
    ...overrides,
  },
  evidence: null,
  usage: null,
  error: null,
  history: [],
});

describe.each([
  ["human", (record: FindingRecord): string => renderHuman(buildReport([record]), true)],
  ["Markdown", (record: FindingRecord): string => renderMarkdown(buildReport([record]))],
] as const)("%s review output", (_format, render) => {
  it("keeps the model estimate visible when policy requires review", () => {
    const record = reviewRecord();
    const before = structuredClone(record);
    const output = render(record);

    expect(output).toContain("Review required: Jev detected text aimed at influencing");
    expect(output).toContain("Model estimate of exploitability: 95%.");
    expect(output).not.toContain("Assessment inconclusive");
    expect(output).not.toContain("Likely vulnerabilities (");
    expect(record).toEqual(before);
  });

  it("identifies an inconclusive assessment separately from a review requirement", () => {
    const output = render(reviewRecord({ rule: "uncertain", probabilities: { exploitable: 0.5 } }));

    expect(output).toContain("Assessment inconclusive: Review how input reaches");
    expect(output).not.toContain("Review required:");
    expect(output).toContain("Model estimate of exploitability: 50%.");
  });

  it.each(["future-rule", "constructor"])(
    "retains review for an unknown policy rule: %s",
    (rule) => {
      const output = render(reviewRecord({ rule, reason: "Inspect the saved evidence." }));

      expect(output).toContain("Review required: Inspect the saved evidence.");
      expect(output).not.toContain("Assessment inconclusive");
    },
  );
});

it("escapes an unknown policy explanation in Markdown", () => {
  const output = renderMarkdown(
    buildReport([reviewRecord({ rule: "future-rule", reason: "Check <script>\n# heading" })]),
  );

  expect(output).toContain("Review required: Check \\<script\\> \\# heading");
  expect(output).not.toContain("\n# heading");
});
