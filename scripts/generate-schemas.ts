import { mkdir, writeFile } from "node:fs/promises";

import { z } from "zod";

import { configSchema } from "../src/config/schema.ts";
import { labelsSchema } from "../src/eval/metrics.ts";
import { recordSchema, runSchema } from "../src/state/schema.ts";

const SCHEMAS = {
  config: configSchema,
  "finding-record": recordSchema,
  run: runSchema,
  labels: labelsSchema,
} as const;

await mkdir("schemas", { recursive: true });
for (const [name, schema] of Object.entries(SCHEMAS)) {
  const json = z.toJSONSchema(schema, { io: "input" });
  await writeFile(`schemas/${name}.schema.json`, `${JSON.stringify(json, null, 2)}\n`);
}
