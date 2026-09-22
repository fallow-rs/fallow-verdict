import { z } from "zod";

export const RECORD_SCHEMA = "fallow-verdict-record/v1";
export const RUN_SCHEMA = "fallow-verdict-run/v1";

const probability = z.number().min(0).max(1);
const verdict = z.enum(["survivor", "dismissed", "needs-human-review"]);

export const decisionSchema = z.object({
  verdict,
  rule: z.string(),
  confidence: probability,
  probabilities: z.record(z.string(), z.number()),
  impact: z.object({ score: z.number(), label: z.string() }).nullable(),
  fixDirection: z.string().nullable(),
  dismissalReason: z.string().nullable(),
  reason: z.string(),
});

const answerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), probability }),
  z.object({
    type: z.literal("choice"),
    choice: z.string(),
    probabilities: z.record(z.string(), probability),
    confidence: probability,
  }),
  z.object({
    type: z.literal("score"),
    score: z.number(),
    probabilities: z.array(probability),
    confidence: probability,
  }),
]);

const historyEntrySchema = z.object({
  at: z.string(),
  runId: z.string(),
  verdict,
  rule: z.string(),
  confidence: probability,
  fingerprint: z.string(),
  model: z.string(),
});

export const recordSchema = z.object({
  schema_version: z.literal(RECORD_SCHEMA),
  finding_id: z.string().min(1),
  path: z.string(),
  line: z.number(),
  /** Zero-based byte column from Fallow; null for legacy records without a column. */
  col: z.number().int().nonnegative().nullable().default(null),
  category: z.string().nullable(),
  severity: z.enum(["high", "medium", "low"]),
  /**
   * `pending`: not judged yet, or the evidence changed since the last verdict.
   * `resolved`: fallow no longer reports the candidate.
   */
  status: z.enum(["pending", "judged", "error", "resolved"]),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  /** Packet fingerprint the current decision was made on. */
  fingerprint: z.string().nullable(),
  questionSet: z.string().nullable(),
  questionHash: z.string().nullable().default(null),
  /** Requested model and endpoint used for the cached judgment. */
  engine: z.string().nullable().default(null),
  /** Raw engine answers, kept so a policy change can be applied without asking again. */
  answers: z.record(z.string(), answerSchema).nullable().default(null),
  decision: decisionSchema.nullable(),
  evidence: z
    .object({
      truncated: z.boolean(),
      windows: z.number(),
      hasSource: z.boolean(),
      hasTrace: z.boolean(),
    })
    .nullable(),
  usage: z
    .object({ inputTokens: z.number(), costUsd: z.number(), latencyMs: z.number() })
    .nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  /** Append-only. Never rewritten, so a verdict flip stays visible. */
  history: z.array(historyEntrySchema),
});

export type FindingRecord = z.infer<typeof recordSchema>;
export type StoredDecision = z.infer<typeof decisionSchema>;

export const runSchema = z.object({
  schema_version: z.literal(RUN_SCHEMA),
  runId: z.string(),
  command: z.string(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  outcome: z.enum(["running", "done", "error", "interrupted", "budget-exhausted"]),
  engine: z.string().nullable(),
  stats: z.object({
    judged: z.number(),
    skipped: z.number(),
    errors: z.number(),
    inputTokens: z.number(),
    costUsd: z.number(),
  }),
});

export type RunRecord = z.infer<typeof runSchema>;
