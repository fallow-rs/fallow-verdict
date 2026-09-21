# Configuration

`fallow-verdict.config.{ts,mjs,js,json}` is found by walking up from the working directory.
TypeScript config needs Node 22.18 or newer. All keys are optional; unknown keys are rejected.

```ts
import { defineConfig } from "fallow-verdict/config";

export default defineConfig({
  root: ".",
  dataDir: ".fallow-verdict",
  failOn: "survivor", // "off" | "survivor" | "needs-human-review"
  fallow: { binary: undefined, timeoutMs: undefined },
  engine: {
    model: "jev-latest",
    apiKeyEnv: "TYPESAFE_API_KEY", // name of the variable, never the key
    baseUrl: undefined,
    timeoutMs: 10_000,
    concurrency: 8,
  },
  packet: { radius: 20, maxStateTokens: 28_000, blind: false },
  policy: {
    survivorMinExploitable: 0.7,
    dismissMaxExploitable: { high: 0.05, medium: 0.1, low: 0.15 },
    dismissMinReasonStrength: 0.8,
    tamperingMax: 0.5,
  },
});
```

Pin `engine.model` to a concrete version to avoid alias drift. Fresh calls may still vary. The version that answered is
stored on every decision.

Policy thresholds only change how answers are mapped. Raw answers are stored, so after a
threshold change the next `judge`, `run`, `report`, or `eval` maps them again locally, without engine calls, and
records the change in the finding's history.

JSON Schemas for the config, finding records, and labels are published in `schemas/`.
