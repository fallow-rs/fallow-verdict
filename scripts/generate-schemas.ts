import { mkdir, writeFile } from "node:fs/promises";

import { z } from "zod";

import { configSchema } from "../src/config/schema.ts";
import { labelsSchema } from "../src/eval/metrics.ts";
import { judgeOutputSchema, reportOutputSchema } from "../src/report/actions.ts";
import { checkReportSchema } from "../src/report/check.ts";
import { recordSchema, runSchema, securityEvidenceSchema } from "../src/state/schema.ts";

const SCHEMAS = {
  config: configSchema,
  "finding-record": recordSchema,
  run: runSchema,
  labels: labelsSchema,
  check: checkReportSchema,
  report: reportOutputSchema,
  judge: judgeOutputSchema,
} as const;

const toJson = (schema: z.ZodType): Record<string, unknown> =>
  z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;

/**
 * `z.toJSONSchema` does not emit the security rule of the record `superRefine`. A record
 * without `kind` is a security record, and `properties` applies only to a key that is present,
 * so the condition also matches a record with no `kind`.
 */
const securityRecordRule = (): Record<string, unknown> => {
  const { $schema: _schema, ...evidence } = toJson(securityEvidenceSchema);
  return {
    if: {
      anyOf: [
        { not: { required: ["kind"] } },
        { required: ["kind"], properties: { kind: { const: "security" } } },
      ],
    },
    // oxlint-disable-next-line unicorn/no-thenable -- a JSON Schema keyword; nothing awaits it.
    then: {
      properties: {
        severity: { type: "string", enum: ["high", "medium", "low"] },
        evidence: { anyOf: [evidence, { type: "null" }] },
      },
    },
  };
};

await mkdir("schemas", { recursive: true });
for (const [name, schema] of Object.entries(SCHEMAS)) {
  const json = toJson(schema);
  if (name === "finding-record") json["allOf"] = [securityRecordRule()];
  await writeFile(`schemas/${name}.schema.json`, `${JSON.stringify(json, null, 2)}\n`);
}
