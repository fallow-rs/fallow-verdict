/** Returns the page of `items` that starts at `offset`, or an empty page past the end. */
export const page = <T>(items: readonly T[], offset: number, size: number): T[] => {
  if (items.length >= 0 && offset >= items.length) return [];
  return items.slice(offset, offset + size);
};

/** Counts the items that pass `keep`. */
export const countWhere = <T>(items: readonly T[], keep: (item: T) => boolean): number => {
  let count = 0;
  for (const item of items) if (keep(item)) count += 1;
  return count;
};

/** The largest value, or `undefined` for an empty list. */
export const largest = (values: readonly number[]): number | undefined => {
  if (values.length === 0) return undefined;
  let best = values[0] as number;
  for (const value of values) if (value > best) best = value;
  return best;
};
