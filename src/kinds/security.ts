import { parseSecurityOutput, runSecurityScan, runSurvivors } from "../fallow/run.ts";
import type { SecurityFinding, SecurityOutput } from "../fallow/types.ts";
import { buildPacket, type BuiltPacket } from "../packet/build.ts";
import { decide } from "../policy/decide.ts";
import { QUESTION_SET_VERSION } from "../questions/catalog.ts";
import { questionHash, questionsForProfile } from "../questions/category.ts";
import { toVerdictsFile } from "../verdicts/export.ts";
import type { AnalysisAdapter } from "./adapter.ts";

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
      }),
    parse: parseSecurityOutput,
    candidates: (output) => output.security_findings,
  },
  identity: (finding) => ({
    finding_id: finding.finding_id,
    path: finding.path,
    line: finding.line,
    col: finding.col ?? null,
    category: finding.category ?? null,
    severity: finding.severity,
  }),
  packet: {
    build: (finding, output, loaded) =>
      buildPacket(finding, output, { root: loaded.root, ...loaded.config.packet }),
    summary: (built) => ({
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
