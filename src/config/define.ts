import type { VerdictConfigInput } from "./schema.ts";

export type { VerdictConfigInput } from "./schema.ts";

/** Identity helper that gives `fallow-verdict.config.ts` autocomplete and type checking. */
export const defineConfig = (config: VerdictConfigInput): VerdictConfigInput => config;
