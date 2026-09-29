const SHELL_SAFE = /^[\w./:@=+,-]+$/;

/** Quotes one argument for a POSIX shell, so that a printed command runs as shown. */
export const quote = (value: string): string =>
  SHELL_SAFE.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
