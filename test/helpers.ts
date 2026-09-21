import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { configSchema } from "../src/config/schema.ts";
import type { LoadedConfig } from "../src/config/load.ts";
import type { Answer, DecisionEngine } from "../src/engine/types.ts";
import type { SecurityFinding, SecurityOutput } from "../src/fallow/types.ts";
import { ok } from "../src/util/result.ts";

export const SINK_FILE = "src/routes/user.ts";

export const SINK_SOURCE = [
  'import { db } from "../db";',
  "",
  "export const handler = async (req, res) => {",
  "  const id = req.query.id;",
  "  const rows = await db.query(`SELECT * FROM users WHERE id = ${id}`);",
  "  res.json(rows);",
  "};",
  "",
].join("\n");

export const makeProject = async (
  files: Record<string, string> = { [SINK_FILE]: SINK_SOURCE },
): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), "fallow-verdict-"));
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return root;
};

export const makeFinding = (overrides: Partial<SecurityFinding> = {}): SecurityFinding => ({
  finding_id: "security:tainted-sink:src/routes/user.ts:5",
  kind: "tainted-sink",
  category: "sql-injection",
  cwe: 89,
  path: SINK_FILE,
  line: 5,
  col: 21,
  evidence: "db.query receives a non-literal argument",
  source_backed: true,
  severity: "high",
  trace: [
    { path: SINK_FILE, line: 4, col: 13, role: "untrusted-source" },
    { path: SINK_FILE, line: 5, col: 21, role: "sink" },
  ],
  actions: [],
  candidate: {
    source_kind: "http-request-input",
    sink: {
      path: SINK_FILE,
      line: 5,
      col: 21,
      category: "sql-injection",
      cwe: 89,
      callee: "db.query",
    },
    boundary: { client_server: false, cross_module: false },
  },
  ...overrides,
});

export const makeOutput = (findings: SecurityFinding[]): SecurityOutput =>
  ({
    schema_version: "8",
    version: "3.27.0",
    elapsed_ms: 1,
    config: {
      rules: {
        security_client_server_leak: { configured: "off", effective: "off" },
        security_sink: { configured: "warn", effective: "warn" },
      },
      categories_include: null,
      categories_exclude: null,
    },
    security_findings: findings,
    unresolved_edge_files: 0,
    unresolved_callee_sites: 0,
  }) as unknown as SecurityOutput;

export const makeLoaded = (
  root: string,
  overrides: Record<string, unknown> = {},
): LoadedConfig => ({
  config: configSchema.parse(overrides),
  root,
  dataDir: path.join(root, ".fallow-verdict"),
  configPath: null,
});

export type Probabilities = {
  attacker_controlled: number;
  reaches_sink: number;
  mitigated: number;
  exploitable: number;
  non_production: number;
  tampering: number;
};

export const VULNERABLE: Probabilities = {
  attacker_controlled: 0.95,
  reaches_sink: 0.93,
  mitigated: 0.04,
  exploitable: 0.94,
  non_production: 0.02,
  tampering: 0.01,
};

export const SAFE_MITIGATED: Probabilities = {
  attacker_controlled: 0.9,
  reaches_sink: 0.85,
  mitigated: 0.96,
  exploitable: 0.02,
  non_production: 0.02,
  tampering: 0.01,
};

export const answersFor = (p: Probabilities, impactScore = 2.8): Record<string, Answer> => ({
  ...Object.fromEntries(
    Object.entries(p).map(([id, probability]) => [id, { type: "noul", probability } as const]),
  ),
  impact: {
    type: "score",
    score: impactScore,
    probabilities: [0, 0.05, 0.1, 0.85],
    confidence: 0.8,
  },
  fix_direction: {
    type: "choice",
    choice: "avoid-shell",
    probabilities: { "avoid-shell": 0.9, none: 0.1 },
    confidence: 0.88,
  },
});

export const mockEngine = (
  respond: (state: unknown) => Probabilities,
): DecisionEngine & { calls: number } => {
  const engine = {
    id: "mock",
    calls: 0,
    evaluate: (request: { state: unknown }) => {
      engine.calls += 1;
      return Promise.resolve(
        ok({
          model: "mock-1",
          answers: answersFor(respond(request.state)),
          inputTokens: 1000,
          latencyMs: 1,
        }),
      );
    },
  };
  return engine;
};
