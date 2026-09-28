import { z } from "zod";

import { DEFAULT_KIND, KIND_NAME_PATTERN } from "../kinds/names.ts";

export const RECORD_SCHEMA = "fallow-verdict-record/v1";
export const RUN_SCHEMA = "fallow-verdict-run/v1";

const probability = z.number().min(0).max(1);
/** The shared verdict vocabulary. Each kind maps its own outcome onto these three values. */
const verdict = z.enum(["survivor", "dismissed", "needs-human-review"]);
const kindName = z.string().regex(KIND_NAME_PATTERN);

export const locationSchema = z.object({
  path: z.string(),
  line: z.number(),
  col: z.number().int().nonnegative().nullable(),
});

export const decisionSchema = z.object({
  verdict,
  rule: z.string(),
  confidence: probability,
  probabilities: z.record(z.string(), z.number()),
  impact: z.object({ score: z.number(), label: z.string() }).nullable(),
  fixDirection: z.string().nullable(),
  dismissalReason: z.string().nullable(),
  reason: z.string(),
  /** Kind-owned data next to the shared verdict, for example the outcome of the kind's contract. */
  kindData: z.record(z.string(), z.unknown()).optional(),
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
  /** Fallow analysis that reported the candidate. Records from before kinds existed are security records. */
  kind: kindName.default(DEFAULT_KIND),
  finding_id: z.string().min(1),
  /** Primary location. A kind with more than one location also stores `locations`. */
  path: z.string(),
  line: z.number(),
  /** Zero-based byte column from Fallow; null for legacy records without a column. */
  col: z.number().int().nonnegative().nullable().default(null),
  /** All locations, primary first. Absent when the primary location is the only one. */
  locations: z.array(locationSchema).min(2).optional(),
  category: z.string().nullable(),
  /** Fallow severity. Security records always have one; null for a kind without a severity. */
  severity: z.enum(["high", "medium", "low"]).nullable(),
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
  /**
   * Evidence summary. The pipeline reads only `truncated`; each kind owns the other fields.
   * Security adds `windows`, `hasSource` and `hasTrace`.
   */
  evidence: z.looseObject({ truncated: z.boolean() }).nullable(),
  usage: z
    .object({ inputTokens: z.number(), costUsd: z.number(), latencyMs: z.number() })
    .nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  /** Append-only. Never rewritten, so a verdict flip stays visible. */
  history: z.array(historyEntrySchema),
});

export type FindingRecord = z.infer<typeof recordSchema>;
export type StoredDecision = z.infer<typeof decisionSchema>;
export type Location = z.infer<typeof locationSchema>;

/** Every location of a record, primary first. */
export const recordLocations = (record: FindingRecord): Location[] =>
  record.locations ?? [{ path: record.path, line: record.line, col: record.col }];

export const runSchema = z.object({
  schema_version: z.literal(RUN_SCHEMA),
  runId: z.string(),
  /** Runs from before kinds existed are security runs. */
  kind: kindName.default(DEFAULT_KIND),
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
