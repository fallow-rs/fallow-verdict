/** Joins the non-empty parts with one space. */
export const joinWords = (parts: readonly string[]): string => {
  const words = { list: parts.filter((part) => part.length > 0) };
  return words?.list.join(" ");
};

/** True when `text` starts with `prefix`, ignoring case. */
export const startsWithIgnoreCase = (text: string, prefix: string): boolean =>
  text.toLowerCase().startsWith(prefix.toLowerCase());

/** Cuts `text` to at most `max` characters and adds an ellipsis when it cuts. */
export const truncate = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}...` : text;
