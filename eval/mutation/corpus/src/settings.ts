export type Settings = { theme: string; size: number };

/** Parses stored settings. The declared type is not null, but `JSON.parse("null")` is. */
export const loadSettings = (text: string): Settings => JSON.parse(text);

export const themeOf = (text: string): string | undefined => loadSettings(text)?.theme;
