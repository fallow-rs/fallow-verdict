import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type { SecurityOutput } from "../fallow/types.ts";
import { buildPacket, type PacketOptions } from "../packet/build.ts";
import { digest, type ComparisonCase } from "./comparison.ts";

/** Labels bind to reviewed source and sink semantics, not filenames alone. */
export const corpusLabelsSchema = z.record(
  z.string(),
  z.object({
    path: z.string(),
    category: z.string(),
    callee: z.string(),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    expected: z.enum(["safe", "vulnerable"]),
    mustReview: z.boolean().default(false),
    rationale: z.string().min(1),
    threatAssumptions: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  }),
);

/** Refuse relabeling caused by scanner or fixture drift before making any model requests. */
export const prepareCorpus = async (
  output: SecurityOutput,
  rawLabels: unknown,
  options: PacketOptions,
): Promise<{ cases: ComparisonCase[]; corpusHash: string }> => {
  const labels = corpusLabelsSchema.parse(rawLabels);
  if (
    Object.keys(labels).length === 0 ||
    output.security_findings.length !== Object.keys(labels).length
  )
    throw new Error("Corpus candidate coverage changed. Review the labels before evaluating.");
  const seen = new Set<string>();
  const cases: ComparisonCase[] = [];
  for (const finding of output.security_findings) {
    const label = labels[finding.path];
    if (label === undefined || label.path !== finding.path || seen.has(finding.path))
      throw new Error(`Missing or ambiguous corpus label for ${finding.path}.`);
    seen.add(finding.path);
    if (label.category !== finding.category || label.callee !== finding.candidate.sink.callee)
      throw new Error(`Candidate semantics changed for ${finding.path}.`);
    const source = await readFile(path.join(options.root, finding.path));
    if (createHash("sha256").update(source).digest("hex") !== label.sourceSha256)
      throw new Error(`Reviewed source changed for ${finding.path}.`);
    const built = await buildPacket(finding, output, options);
    if (built.stateTokens > options.maxStateTokens)
      throw new Error(`Corpus packet exceeds the token limit: ${finding.path}.`);
    cases.push({ id: finding.path, expected: label.expected, mustReview: label.mustReview, built });
  }
  return {
    cases,
    corpusHash: digest(
      cases.map((item) => ({ id: item.id, packet: item.built.packet, label: labels[item.id] })),
    ),
  };
};
