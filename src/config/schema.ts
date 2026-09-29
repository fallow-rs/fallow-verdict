import { z } from "zod";

import { DEFAULT_MODEL, DEFAULT_REQUESTS_PER_MINUTE } from "../engine/jev.ts";

const probability = z.number().min(0).max(1);

export const policySchema = z
  .object({
    /** Minimum P(exploitable) to call a candidate a survivor. */
    survivorMinExploitable: probability.default(0.7),
    /**
     * Maximum P(exploitable) at which a candidate may be dismissed, per fallow
     * severity. A wrong dismissal hides a real vulnerability, so the bar rises with severity.
     */
    dismissMaxExploitable: z
      .object({
        high: probability.default(0.05),
        medium: probability.default(0.1),
        low: probability.default(0.15),
      })
      .prefault({}),
    /** A dismissal needs a named reason at least this strong. */
    dismissMinReasonStrength: probability.default(0.8),
    /** At or above this P(tampering) the candidate always goes to a human. */
    tamperingMax: probability.default(0.5),
    /**
     * A dismissal needs a second, identical engine call whose answers also map to a dismissal.
     * Set to false only to compare with the single-call behavior.
     */
    confirmDismissals: z.boolean().default(true),
  })
  .strict();

const FAIL_ON = ["off", "survivor", "needs-human-review"] as const;

/** A rule name is also part of a question id, so it must be a safe identifier. */
export const REVIEW_RULE_NAME = /^[a-z][a-z0-9-]*$/;

const globs = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

export const reviewRuleSchema = z
  .object({
    /** Unique name. It appears in the report and in the question id. */
    name: z.string().regex(REVIEW_RULE_NAME),
    /** Project-relative glob, or a list of globs, of the files that the rule covers. */
    where: globs,
    /** Globs of files that the rule does not cover, even when `where` matches. */
    except: globs.optional(),
    /** One sentence that a function in scope must satisfy. */
    ensure: z.string().min(1),
    /** Minimum P(breach) that makes a breach a finding. Default: `review.ruleFloor`. */
    floor: probability.optional(),
  })
  .strict();

export const reviewSchema = z
  .object({
    /** Maximum number of functions per scan, highest risk first. */
    maxUnits: z.number().int().min(1).max(1_000).default(50),
    /** Minimum P(has_bug) that makes a function a finding. */
    bugFloor: probability.default(0.5),
    /**
     * Minimum P(the function does not do what its name and comment state) that makes a function
     * a finding. The engine answers P(does what it claims), so the check is 1 - P >= this floor.
     */
    claimFloor: probability.default(0.5),
    /** Minimum P(breach) that makes a rule breach a finding, for a rule without `floor`. */
    ruleFloor: probability.default(0.5),
    /** Project rules as sentences. Each rule in scope adds one question to the same request. */
    rules: z
      .array(reviewRuleSchema)
      .default([])
      .refine((rules) => new Set(rules.map((rule) => rule.name)).size === rules.length, {
        message: "Each review rule needs a unique name.",
      }),
    /**
     * A review dismissal means "no likely problem found". It removes nothing that Fallow reports,
     * so a second, confirming call is off by default. Set to true to apply the two-call rule.
     */
    confirmDismissals: z.boolean().default(false),
    /** Review mode is advisory: it fails the run only when this is set. `--fail-on` overrides it. */
    failOn: z.enum(FAIL_ON).default("off"),
  })
  .strict();

export const configSchema = z
  .object({
    /** Project root that fallow analyzes. Relative to the config file. */
    root: z.string().default("."),
    /** Where state is kept. Relative to the root. */
    dataDir: z.string().default(".fallow-verdict"),
    /** Opt into destination-specific questions for SSRF and open redirects. */
    questionProfile: z.enum(["generic", "category"]).default("generic"),
    fallow: z
      .object({
        binary: z.string().optional(),
        timeoutMs: z.number().int().positive().optional(),
      })
      .strict()
      .prefault({}),
    engine: z
      .object({
        model: z.string().default(DEFAULT_MODEL),
        baseUrl: z.url().optional(),
        /** Name of the environment variable that holds the API key. The key itself never goes in config. */
        apiKeyEnv: z.string().default("TYPESAFE_API_KEY"),
        timeoutMs: z.number().int().positive().default(10_000),
        concurrency: z.number().int().min(1).max(64).default(8),
        /** Upper bound on Jev requests per minute for the whole run, retries included. */
        requestsPerMinute: z
          .number()
          .int()
          .min(1)
          .max(100_000)
          .default(DEFAULT_REQUESTS_PER_MINUTE),
      })
      .strict()
      .prefault({}),
    packet: z
      .object({
        radius: z.number().int().min(1).max(200).default(20),
        maxStateTokens: z.number().int().min(1_000).max(32_000).default(28_000),
        blind: z.boolean().default(false),
      })
      .strict()
      .prefault({}),
    policy: policySchema.prefault({}),
    review: reviewSchema.prefault({}),
    /** Verdicts at or above this level make `run` and `report` exit 1. */
    failOn: z.enum(FAIL_ON).default("survivor"),
  })
  .strict();

export type VerdictConfig = z.infer<typeof configSchema>;
export type VerdictConfigInput = z.input<typeof configSchema>;
export type Policy = z.infer<typeof policySchema>;
export type ReviewConfig = z.infer<typeof reviewSchema>;
export type ReviewRule = z.infer<typeof reviewRuleSchema>;
export type FailOn = (typeof FAIL_ON)[number];
