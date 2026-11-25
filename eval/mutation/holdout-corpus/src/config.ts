export type ServerConfig = { port: number; host: string };

/** Reads a stored config. The cast hides that `JSON.parse` can return `null`. */
export const portOf = (stored: string): number => {
  const config = JSON.parse(stored) as ServerConfig;
  return config?.port ?? 8080;
};

/** The first non-empty name, trimmed. */
export const firstName = (names: readonly string[]): string | undefined => {
  const found = names.find((name) => name.trim().length > 0);
  return found?.trim();
};
