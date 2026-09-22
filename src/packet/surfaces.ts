import type { SecurityFinding, SecurityOutput } from "../fallow/types.ts";

type Surface = NonNullable<SecurityFinding["attack_surface"]>;

/** Structural evidence for one matching route, without scanner review instructions. */
export type SurfaceEvidence = {
  source: Surface["source"];
  path: Surface["path"];
  controls: Surface["defensive_boundary"]["controls"];
};

const sinkIdentity = (sink: Surface["sink"]): string =>
  JSON.stringify([sink.path, sink.line, sink.col, sink.category ?? null]);

/** Stable order and identity prevent duplicate surface routes from changing evidence. */
export const uniqueEvidence = <T>(values: readonly T[]): T[] =>
  [...new Map(values.map((value) => [JSON.stringify(value), value])).entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value);

/** Fallow emits surfaces at the top level; older integrations may retain the inline field. */
export const surfacesFor = (
  finding: SecurityFinding,
  output: SecurityOutput,
): SurfaceEvidence[] => {
  if (finding.kind !== "tainted-sink") return [];
  const identity = sinkIdentity(finding.candidate.sink);
  const surfaces = [...(output.attack_surface ?? [])];
  if (finding.attack_surface) surfaces.push(finding.attack_surface);
  return uniqueEvidence(
    surfaces
      .filter((surface) => sinkIdentity(surface.sink) === identity)
      .map((surface) => ({
        source: {
          path: surface.source.path,
          line: surface.source.line,
          col: surface.source.col,
        },
        path: surface.path.map(({ path, line, col, role }) => ({ path, line, col, role })),
        controls: uniqueEvidence(
          surface.defensive_boundary.controls.map(({ kind, path, line, col, callee }) => ({
            kind,
            path,
            line,
            col,
            callee,
          })),
        ),
      })),
  );
};
