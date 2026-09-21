# Privacy

## What is sent

One request per judged candidate goes to the engine (`https://api.typesafe.ai/v1/systemone` by
default, `engine.baseUrl` to override). The request body holds the question set and one packet:

- fallow's candidate metadata: finding id, kind, category, CWE, severity, evidence label, sink
  callee, boundary flags, trace locations, reachability flags, detected control locations
- numbered source windows around the sink, the source, trace hops, and controls

Paths are project-relative. Files outside the project root are never read, including through
symlinks. With `packet.blind`, category, CWE, and the evidence label are withheld.

`scan`, `status`, `report`, `eval`, and any `--dry-run` send nothing.

## What is stored

`.fallow-verdict/` holds fallow's output, per-finding records, run records, and derived reports.
It contains no source text beyond what fallow's own output includes, and no credentials. Files are
written with mode `0600`. `init` adds the directory to `.gitignore`. Treat it as private review
material.

## Credentials

The API key is read from the environment variable named by `engine.apiKeyEnv`. It is never
written to config, state, logs, or error messages.

## The engine's terms

Data handling by the engine is governed by its provider's terms, not by this tool. Check the
provider's current documentation for training, retention, and zero-retention options before
sending proprietary code, and confirm what you need contractually.

## Hostile repository content

Source windows are untrusted input to the engine. The engine has no tools and can only return
probabilities inside the question schema, so the worst case is a shifted probability. The policy
limits what a shift can do: dismissal needs several independent answers to agree, a canary
question routes self-arguing code to a human, and the `finding_id` is never taken from a response.
