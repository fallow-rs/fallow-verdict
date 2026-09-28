export const isBlankText = (value: string): boolean => {
  const trimmed = value.trim();
  return trimmed.length === 0;
};

export const normalizeTags = (tags: readonly string[]): string[] => {
  const result: string[] = [];
  for (const tag of tags) {
    const cleaned = tag.trim().toLowerCase();
    if (cleaned.length > 0) result.push(cleaned);
  }
  return result;
};

export const parseUserId = (raw: string): number | null => {
  const value = Number.parseInt(raw.trim(), 10);
  if (Number.isNaN(value) || value <= 0) return null;
  return value;
};
