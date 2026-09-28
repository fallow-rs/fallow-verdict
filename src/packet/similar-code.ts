import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  runSimilarCodeInspect,
  type SimilarCodeCandidate,
  type SimilarCodeInspectOutput,
  type SimilarCodeOutput,
} from "../fallow/similar-code.ts";
import type { FallowInvocation } from "../fallow/run.ts";
import type { BuiltEvidence } from "../kinds/adapter.ts";
import { estimateTokens } from "../util/tokens.ts";

export const PAIR_PACKET_VERSION = "similar-code-pair/v1";

/** Fallow appends this line when it cuts a source window. */
const WINDOW_CUT_MARKER = "/* source window truncated */";

/** Inspect diagnostics that say part of the evidence is missing or cut. */
const TRUNCATION_CODES: ReadonlySet<string> = new Set([
  "FALLOW_SIMILAR_CODE_GRAPH_ENRICHMENT_TRUNCATED",
  "FALLOW_SIMILAR_CODE_ENRICHMENT_INPUT_LIMIT",
  "FALLOW_SIMILAR_CODE_SOURCE_READ_FAILED",
]);

type Side = SimilarCodeInspectOutput["packet"]["left"];

type PairSide = {
  path: string;
  name: string;
  start_line: number;
  end_line: number;
};

/** The engine state for one pair. It holds only what Fallow reported and inspect returned. */
export type PairPacket = {
  schema: typeof PAIR_PACKET_VERSION;
  candidate: {
    left: PairSide;
    right: PairSide;
    similarity_band: SimilarCodeCandidate["similarity_band"];
  };
  /** Inspect evidence for both sides, or null when inspect failed. */
  evidence: {
    graph_relationship: string | null;
    availability: SimilarCodeInspectOutput["packet"]["availability"];
    left: Side;
    right: Side;
  } | null;
  /** Inspect diagnostics, so missing evidence is stated, never hidden. */
  diagnostics: { code: string; message: string }[];
  /** Why the evidence is incomplete, or an empty list. */
  omissions: string[];
};

export type BuiltPair = BuiltEvidence & {
  packet: PairPacket;
  candidateId: string;
  reviewKey: string;
};

const side = (location: SimilarCodeCandidate["left"]): PairSide => ({
  path: location.path,
  name: location.name,
  start_line: location.start_line,
  end_line: location.end_line,
});

const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    typeof inner === "object" && inner !== null && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).toSorted(([a], [b]) => a.localeCompare(b)))
      : inner,
  );

const digest = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

/** Every reason that the inspect evidence is incomplete. */
export const omissionsOf = (inspect: SimilarCodeInspectOutput): string[] => {
  const omissions: string[] = [];
  for (const [label, evidence] of [
    ["left", inspect.packet.left],
    ["right", inspect.packet.right],
  ] as const) {
    const window = evidence.source_window;
    if (window === null || window === undefined) omissions.push(`${label} source window missing`);
    else if (window.trimEnd().endsWith(WINDOW_CUT_MARKER))
      omissions.push(`${label} source window cut`);
  }
  for (const diagnostic of inspect.diagnostics)
    if (TRUNCATION_CODES.has(diagnostic.code)) omissions.push(diagnostic.code);
  return omissions;
};

const toPacket = (
  candidate: SimilarCodeCandidate,
  inspect: SimilarCodeInspectOutput | null,
  failure: string | null,
): PairPacket => ({
  schema: PAIR_PACKET_VERSION,
  candidate: {
    left: side(candidate.left),
    right: side(candidate.right),
    similarity_band: candidate.similarity_band,
  },
  evidence:
    inspect === null
      ? null
      : {
          graph_relationship: inspect.packet.graph_relationship ?? null,
          availability: inspect.packet.availability,
          left: inspect.packet.left,
          right: inspect.packet.right,
        },
  diagnostics:
    inspect === null ? [] : inspect.diagnostics.map(({ code, message }) => ({ code, message })),
  omissions: inspect === null ? [`inspect failed (${failure ?? "unknown"})`] : omissionsOf(inspect),
});

/** Builds the pair packet from its parts. Pure, so tests can use recorded inspect output. */
export const pairFromInspect = (
  candidate: SimilarCodeCandidate,
  inspect: SimilarCodeInspectOutput | null,
  failure: string | null = null,
): BuiltPair => {
  const packet = toPacket(candidate, inspect, failure);
  return {
    fingerprint: digest(canonicalJson(packet)).slice(0, 32),
    stateTokens: estimateTokens(packet),
    packet,
    truncated: packet.omissions.length > 0,
    candidateId: candidate.candidate_id,
    reviewKey: candidate.review_key,
  };
};

/** Where `buildPairPacket` keeps inspect output between runs. */
export type InspectCache = {
  /** Cache directory under the state of the kind. */
  dir: string;
  /** The stored discovery snapshot. Only packets for this snapshot write to the cache. */
  snapshotPath: string;
};

/** Holds the digest of the snapshot that the cache entries belong to. */
const SNAPSHOT_MARKER = "snapshot";

type CacheEntry = { key: string; inspect: SimilarCodeInspectOutput };

const outputDigests = new WeakMap<object, string>();

const outputDigest = (output: SimilarCodeOutput): string => {
  const known = outputDigests.get(output);
  if (known !== undefined) return known;
  const value = digest(canonicalJson(output));
  outputDigests.set(output, value);
  return value;
};

const snapshotDigests = new Map<string, { mtimeMs: number; size: number; digest: string }>();

/** Digest of the stored snapshot content, or null when there is none. */
const snapshotDigest = async (file: string): Promise<string | null> => {
  try {
    const info = await stat(file);
    const known = snapshotDigests.get(file);
    if (known?.mtimeMs === info.mtimeMs && known.size === info.size) return known.digest;
    const value = digest(canonicalJson(JSON.parse(await readFile(file, "utf8")) as unknown));
    snapshotDigests.set(file, { mtimeMs: info.mtimeMs, size: info.size, digest: value });
    return value;
  } catch {
    return null;
  }
};

const readText = async (file: string): Promise<string | null> => {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
};

const readEntry = async (file: string, key: string): Promise<SimilarCodeInspectOutput | null> => {
  const text = await readText(file);
  if (text === null) return null;
  try {
    const entry = JSON.parse(text) as Partial<CacheEntry>;
    return entry.key === key && entry.inspect !== undefined ? entry.inspect : null;
  } catch {
    return null;
  }
};

const writeAtomic = async (file: string, content: string): Promise<void> => {
  const temp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    await writeFile(temp, content, { mode: 0o600 });
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
};

/**
 * Writes one entry. A new scan changes the snapshot, so the first write after it removes the
 * entries of the old snapshot. A packet for another discovery, for example the fresh run of
 * `check`, never writes, so `check` keeps its promise to write no state.
 */
const writeEntry = async (
  cache: InspectCache,
  output: SimilarCodeOutput,
  file: string,
  entry: CacheEntry,
): Promise<void> => {
  const snapshot = await snapshotDigest(cache.snapshotPath);
  if (snapshot === null || snapshot !== outputDigest(output)) return;
  const marker = path.join(cache.dir, SNAPSHOT_MARKER);
  if ((await readText(marker)) !== snapshot) {
    await rm(cache.dir, { recursive: true, force: true });
    await mkdir(cache.dir, { recursive: true });
    await writeAtomic(marker, snapshot);
  }
  await writeAtomic(file, JSON.stringify(entry));
};

const sourceDigest = async (root: string, file: string): Promise<string> => {
  try {
    return digest(await readFile(path.join(root, file)));
  } catch {
    return "missing";
  }
};

/**
 * Builds the packet for one pair. `packet.build` runs for every record on `scan`, `judge` and
 * `report`, so inspect output is cached on disk. The key holds the discovery generation, the
 * candidate id and the digest of both source files, so an edit after the scan never reuses old
 * evidence. A failed inspect is not cached.
 */
export const buildPairPacket = async (
  candidate: SimilarCodeCandidate,
  output: SimilarCodeOutput,
  invocation: FallowInvocation,
  cache: InspectCache,
): Promise<BuiltPair> => {
  const key = digest(
    canonicalJson([
      output.generation,
      candidate.candidate_id,
      await sourceDigest(invocation.root, candidate.left.path),
      await sourceDigest(invocation.root, candidate.right.path),
    ]),
  );
  const file = path.join(cache.dir, `${key.slice(0, 32)}.json`);
  const cached = await readEntry(file, key);
  if (cached !== null) return pairFromInspect(candidate, cached);
  const inspect = await runSimilarCodeInspect({
    ...invocation,
    candidateId: candidate.candidate_id,
    output,
  });
  // The message can hold a temporary path, so only the stable code enters the fingerprint.
  if (!inspect.ok) return pairFromInspect(candidate, null, inspect.error.code);
  await writeEntry(cache, output, file, { key, inspect: inspect.data });
  return pairFromInspect(candidate, inspect.data);
};
