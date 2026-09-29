import { parseSecurityOutput, runSecurityScan, runSurvivors } from "../fallow/run.ts";
import type { SecurityFinding, SecurityOutput } from "../fallow/types.ts";
import { buildPacket, type BuiltPacket } from "../packet/build.ts";
import { decide } from "../policy/decide.ts";
import { QUESTION_SET_VERSION } from "../questions/catalog.ts";
import { questionHash, questionsForProfile } from "../questions/category.ts";
import { securityPresentation, securityPriority } from "../report/security.ts";
import type { SecurityEvidence } from "../state/schema.ts";
import { toVerdictsFile } from "../verdicts/export.ts";
import type { AnalysisAdapter, MatchKeys } from "./adapter.ts";

/**
 * The id holds the line and the column. The rule, path, sink and evidence text do not move, so
 * they form the main key. The category alone is the rule: the evidence text, the callee text and
 * the path can all change with an edit, and a finding with the same category can be this one.
 */
const securityMatch = (finding: SecurityFinding): MatchKeys => {
  const rule = [finding.kind, finding.category ?? null];
  const sink = [finding.candidate.sink.category ?? null, finding.candidate.sink.callee ?? null];
  const evidence = finding.evidence.trim();
  const categories = new Set([finding.category ?? null, finding.candidate.sink.category ?? null]);
  return {
    key: JSON.stringify([...rule, finding.path, ...sink, evidence]),
    rules: [...categories].map((category) => JSON.stringify([finding.kind, category])),
  };
};

/** `fallow security` candidates, judged per sink and joined by `fallow security survivors`. */
export const securityAdapter: AnalysisAdapter<SecurityOutput, SecurityFinding, BuiltPacket> = {
  kind: "security",
  scan: {
    run: (loaded, scope) =>
      runSecurityScan({
        root: loaded.root,
        binary: loaded.config.fallow.binary,
        timeoutMs: loaded.config.fallow.timeoutMs,
        changedSince: scope.changedSince,
        paths: scope.paths,
        signal: scope.signal,
      }),
    parse: parseSecurityOutput,
    candidates: (output) => output.security_findings,
  },
  identity: (finding) => ({
    finding_id: finding.finding_id,
    locations: [{ path: finding.path, line: finding.line, col: finding.col ?? null }],
    category: finding.category ?? null,
    severity: finding.severity,
  }),
  match: securityMatch,
  priority: securityPriority,
  packet: {
    build: (finding, output, loaded) =>
      buildPacket(finding, output, { root: loaded.root, ...loaded.config.packet }),
    summary: (built): SecurityEvidence => ({
      truncated: built.truncated,
      windows: built.packet.source_windows.length,
      hasSource: built.packet.source_windows.some((window) => window.roles.includes("source")),
      hasTrace: built.packet.trace.length > 0,
    }),
  },
  questions: {
    version: QUESTION_SET_VERSION,
    for: (built, loaded) => questionsForProfile(built.packet, loaded.config.questionProfile),
    hash: (built, loaded) => questionHash(built.packet, loaded.config.questionProfile),
  },
  policy: (answers, built, loaded) => decide(answers, built, loaded.config.policy),
  report: securityPresentation,
  supports: { questionProfile: true, eval: true },
  export: {
    verdicts: toVerdictsFile,
    validate: (loaded, store) =>
      runSurvivors({
        root: loaded.root,
        binary: loaded.config.fallow.binary,
        candidatesPath: store.candidatesPath,
        verdictsPath: store.verdictsPath,
      }),
  },
};
