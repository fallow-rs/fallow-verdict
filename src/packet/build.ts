import { createHash } from "node:crypto";

import type { SecurityFinding, SecurityOutput } from "../fallow/types.ts";
import { estimateTokens } from "../util/tokens.ts";
import { surfacesFor, uniqueEvidence, type SurfaceEvidence } from "./surfaces.ts";
import { collectWindows, type Location, type SourceWindow } from "./windows.ts";

export const PACKET_SCHEMA = "fallow-security-verifier-input/v2";

/** Tried in order until the packet fits the token budget. */
const RADIUS_LADDER: readonly number[] = [20, 12, 6, 3];

export type PacketOptions = {
  root: string;
  radius: number;
  /** Token budget for the engine `state`; Jev documents 32k for state plus the longest question. */
  maxStateTokens: number;
  /** Withhold fallow's category, CWE and evidence label so the engine judges the code alone. */
  blind: boolean;
};

export type VerifierPacket = {
  schema_version: typeof PACKET_SCHEMA;
  finding_id: string;
  severity: SecurityFinding["severity"];
  kind: SecurityFinding["kind"];
  category: string | null;
  cwe: number | null;
  evidence: string | null;
  candidate: SecurityFinding["candidate"];
  trace: SecurityFinding["trace"];
  taint_flow: SecurityFinding["taint_flow"] | null;
  taint_confidence: string | null;
  reachability_trace: SecurityFinding["trace"];
  reachability: {
    reachable_from_entry: boolean;
    reachable_from_untrusted_source: boolean;
    crosses_boundary: boolean;
    blast_radius: number;
  } | null;
  attack_surface: SurfaceEvidence[];
  defensive_controls: SurfaceEvidence["controls"];
  dead_code: { kind: string; guidance: string } | null;
  runtime_state: string | null;
  source_windows: SourceWindow[];
  blind_spots: {
    unresolved_edge_files: number;
    unresolved_callee_sites: number;
  };
};

export type BuiltPacket = {
  packet: VerifierPacket;
  /** Content hash: a changed fingerprint means the evidence changed and the verdict is stale. */
  fingerprint: string;
  stateTokens: number;
  /** Windows were shrunk or dropped to fit the budget. Truncated packets are never auto-dismissed. */
  truncated: boolean;
  unreadable: string[];
};

const locationsOf = (finding: SecurityFinding, surfaces: SurfaceEvidence[]): Location[] => {
  const locations: Location[] = [
    { path: finding.candidate.sink.path, line: finding.candidate.sink.line, role: "sink" },
  ];
  const sources = surfaces.map((surface) => surface.source);
  if (finding.taint_flow) sources.push(finding.taint_flow.source);
  for (const source of sources) {
    locations.push({ path: source.path, line: source.line, role: "source" });
  }
  const hops = [
    ...finding.trace,
    ...(finding.reachability?.untrusted_source_trace ?? []),
    ...surfaces.flatMap((surface) => surface.path),
  ];
  for (const hop of hops) {
    const role =
      hop.role === "sink" ? "sink" : hop.role === "untrusted-source" ? "source" : "trace";
    locations.push({ path: hop.path, line: hop.line, role });
  }
  for (const control of surfaces.flatMap((surface) => surface.controls)) {
    locations.push({ path: control.path, line: control.line, role: "control" });
  }
  return locations;
};

/** Sink and source evidence outlives everything else when the budget forces a cut. */
const dropLeastImportant = (windows: SourceWindow[]): SourceWindow[] | null => {
  for (const role of ["trace", "control", "source"] as const) {
    const index = windows.findLastIndex(
      (window) => window.roles.includes(role) && !window.roles.includes("sink"),
    );
    if (index !== -1) return windows.toSpliced(index, 1);
  }
  return null;
};

const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    typeof inner === "object" && inner !== null && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).toSorted(([a], [b]) => a.localeCompare(b)))
      : inner,
  );

const fingerprintOf = (packet: VerifierPacket): string =>
  createHash("sha256").update(canonicalJson(packet)).digest("hex").slice(0, 32);

const skeleton = (
  finding: SecurityFinding,
  output: SecurityOutput,
  blind: boolean,
  surfaces: SurfaceEvidence[],
): VerifierPacket => {
  const reachability = finding.reachability ?? null;
  const sink = blind
    ? { ...finding.candidate.sink, category: null, cwe: null }
    : finding.candidate.sink;
  return {
    schema_version: PACKET_SCHEMA,
    finding_id: finding.finding_id,
    severity: finding.severity,
    kind: finding.kind,
    category: blind ? null : (finding.category ?? null),
    cwe: blind ? null : (finding.cwe ?? null),
    evidence: blind ? null : finding.evidence,
    candidate: { ...finding.candidate, sink },
    trace: finding.trace,
    taint_flow: finding.taint_flow ?? null,
    taint_confidence: reachability?.taint_confidence ?? null,
    reachability_trace: reachability?.untrusted_source_trace ?? [],
    reachability:
      reachability === null
        ? null
        : {
            reachable_from_entry: reachability.reachable_from_entry,
            reachable_from_untrusted_source: reachability.reachable_from_untrusted_source ?? false,
            crosses_boundary: reachability.crosses_boundary,
            blast_radius: reachability.blast_radius,
          },
    attack_surface: surfaces,
    defensive_controls: uniqueEvidence(surfaces.flatMap((surface) => surface.controls)),
    dead_code: finding.dead_code
      ? { kind: finding.dead_code.kind, guidance: finding.dead_code.guidance }
      : null,
    runtime_state: finding.runtime?.state ?? null,
    source_windows: [],
    blind_spots: {
      unresolved_edge_files: output.unresolved_edge_files,
      unresolved_callee_sites: output.unresolved_callee_sites,
    },
  };
};

/**
 * Builds the self-contained evidence packet for one candidate. The engine has no
 * tools, so everything it may consider has to be in here.
 */
export const buildPacket = async (
  finding: SecurityFinding,
  output: SecurityOutput,
  options: PacketOptions,
): Promise<BuiltPacket> => {
  const surfaces = surfacesFor(finding, output);
  const base = skeleton(finding, output, options.blind, surfaces);
  const locations = locationsOf(finding, surfaces);
  const ladder = [options.radius, ...RADIUS_LADDER.filter((radius) => radius < options.radius)];

  let truncated = false;
  let unreadable: string[] = [];
  let windows: SourceWindow[] = [];
  for (const [attempt, radius] of ladder.entries()) {
    const collected = await collectWindows(options.root, locations, radius);
    windows = collected.windows;
    unreadable = collected.unreadable;
    truncated = attempt > 0;
    if (estimateTokens({ ...base, source_windows: windows }) <= options.maxStateTokens) break;
  }

  while (estimateTokens({ ...base, source_windows: windows }) > options.maxStateTokens) {
    const reduced = dropLeastImportant(windows);
    if (reduced === null) break;
    windows = reduced;
    truncated = true;
  }

  const packet: VerifierPacket = { ...base, source_windows: windows };
  return {
    packet,
    fingerprint: fingerprintOf(packet),
    stateTokens: estimateTokens(packet),
    truncated,
    unreadable,
  };
};
