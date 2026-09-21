import { z } from "zod";

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
        model: z.string().default("jev-latest"),
        baseUrl: z.url().optional(),
        /** Name of the environment variable that holds the API key. The key itself never goes in config. */
        apiKeyEnv: z.string().default("TYPESAFE_API_KEY"),
        timeoutMs: z.number().int().positive().default(10_000),
        concurrency: z.number().int().min(1).max(64).default(8),
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
    /** Verdicts at or above this level make `run` and `report` exit 1. */
    failOn: z.enum(["off", "survivor", "needs-human-review"]).default("survivor"),
  })
  .strict();

export type VerdictConfig = z.infer<typeof configSchema>;
export type VerdictConfigInput = z.input<typeof configSchema>;
export type Policy = z.infer<typeof policySchema>;
