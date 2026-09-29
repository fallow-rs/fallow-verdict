# Configuration

`fallow-verdict.config.{ts,mjs,js,json}` is found by walking up from the working directory.
TypeScript config needs Node 22.18 or newer. All keys are optional; unknown keys are rejected.

```ts
import { defineConfig } from "fallow-verdict/config";

export default defineConfig({
  root: ".",
  dataDir: ".fallow-verdict",
  questionProfile: "generic", // "generic" | "category" (experimental)
  failOn: "survivor", // "off" | "survivor" | "needs-human-review"
  fallow: { binary: undefined, timeoutMs: undefined },
  engine: {
    model: "jev-1.13.0",
    apiKeyEnv: "TYPESAFE_API_KEY", // name of the variable, never the key
    baseUrl: undefined,
    timeoutMs: 10_000,
    concurrency: 8,
    requestsPerMinute: 1_000, // shared by all workers, retries included
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

The default `engine.model` is a concrete version. Stored decisions are keyed on the requested model,
so an alias such as `jev-latest` can move to a new version while old decisions still count as
current. Keep a versioned id unless you accept that risk. Fresh calls may still vary. The version
that answered is stored on every decision.

`engine.requestsPerMinute` spaces requests for the whole run. Jev documents a limit of 1,200
requests per minute and can change it without notice. An HTTP 402 (out of credits) stops the run
at once with `engine_out_of_credits`, like a rejected key.

Policy thresholds only change how answers are mapped. Raw answers are stored, so after a
threshold change the next `judge`, `run`, `report`, or `eval` maps them again locally, without engine calls, and
records the change in the finding's history.

JSON Schemas for the config, finding records, and labels are published in `schemas/`.

## Question profiles

`generic` is the default. `category` adds specific exploitation and mitigation criteria for SSRF
and open redirects. Other categories and blind packets use generic questions. Dismissal thresholds
are identical across profiles. The [paired pilot](evaluation-v2.md) explains why this remains opt-in.

Use `--question-profile category` for an individual command, or persist `questionProfile` in the
config. When using the flag, also pass it to subsequent `report`, `judge`, and `eval` commands.
Otherwise those commands use the configured profile and can invalidate answers from the other
profile. Changing the actual questions invalidates cached answers and requires fresh calls.
