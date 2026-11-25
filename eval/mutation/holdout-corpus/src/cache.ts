const store = new Map<string, { size: number }>();

export const remember = (key: string, size: number): void => {
  store.set(key, { size });
};

/** The size of a stored entry, or 0 when the key is unknown. */
export const sizeOf = (key: string): number => store.get(key)?.size ?? 0;

/** Removes every entry and gives the number of removed entries. */
export const clearAll = (): number => {
  const count = store.size;
  store.clear();
  return count > 0 ? count : 0;
};
