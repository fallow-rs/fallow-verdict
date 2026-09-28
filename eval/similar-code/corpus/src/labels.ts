export function isEmptyString(text: string): boolean {
  const stripped = text.trim();
  return stripped === "";
}

export function tidyNames(names: readonly string[]): string[] {
  const out: string[] = [];
  for (const name of names) {
    out.push(name.trim().toLowerCase());
  }
  return out;
}

export function parseUserAgent(header: string): string | null {
  const match = /(Firefox|Chrome|Safari)\/[\d.]+/.exec(header.trim());
  if (match === null) return null;
  return match[1] ?? null;
}
