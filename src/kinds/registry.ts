import type { AnalysisAdapter, BuiltEvidence } from "./adapter.ts";
import type { AnalysisKind, KindName } from "./names.ts";
import { reviewAdapter } from "./review.ts";
import { securityAdapter } from "./security.ts";
import { similarCodeAdapter } from "./similar-code.ts";

/** Receives an adapter without knowing its output, candidate and packet types. */
export type AdapterUser<R> = <Output, Candidate, Built extends BuiltEvidence>(
  adapter: AnalysisAdapter<Output, Candidate, Built>,
) => R;

/**
 * A registered kind hides the type parameters of its adapter. Each kind has different
 * types, so the registry cannot hold the adapters directly without losing type safety.
 */
export type RegisteredKind = {
  kind: KindName;
  use: <R>(user: AdapterUser<R>) => R;
};

const register = <Output, Candidate, Built extends BuiltEvidence>(
  adapter: AnalysisAdapter<Output, Candidate, Built>,
): RegisteredKind => ({ kind: adapter.kind, use: (user) => user(adapter) });

const REGISTRY: Readonly<Record<AnalysisKind, RegisteredKind>> = {
  security: register(securityAdapter),
  review: register(reviewAdapter),
  "similar-code": register(similarCodeAdapter),
};

export const kindFor = (kind: AnalysisKind): RegisteredKind => REGISTRY[kind];
