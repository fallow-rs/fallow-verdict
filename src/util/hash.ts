import { createHash } from "node:crypto";

/** JSON with the keys of each object sorted, so equal values give equal text. */
export const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    typeof inner === "object" && inner !== null && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).toSorted(([a], [b]) => a.localeCompare(b)))
      : inner,
  );

/** The SHA-256 digest of a text or a buffer, in hex. */
export const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");
