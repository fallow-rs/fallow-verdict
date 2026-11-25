/** Keeps `index` inside `0..length - 1`, or gives -1 for an empty list. */
export const clampIndex = (index: number, length: number): number => {
  if (length <= 0) return -1;
  const low = Math.max(0, index);
  return low >= 0 && low < length ? low : length - 1;
};

/** The average of the values, or 0 for an empty list. */
export const average = (values: readonly number[]): number => {
  const count = values.length;
  if (count === 0) return 0;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / count;
};

/** True when `value` is between `min` and `max`, both included. */
export const between = (value: number, min: number, max: number): boolean =>
  value >= min && value <= max;
