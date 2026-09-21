/**
 * Jev bills per input token and does not document its tokenizer. Source code
 * tokenizes denser than prose, so this estimate includes extra headroom.
 * It remains a heuristic, not an exact tokenizer or provider billing guarantee.
 */
const CHARS_PER_TOKEN = 3;

export const USD_PER_MILLION_INPUT_TOKENS = 0.042;

export const estimateTokens = (value: unknown): number => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Math.ceil(text.length / CHARS_PER_TOKEN);
};

export const tokensToUsd = (tokens: number): number =>
  (tokens / 1_000_000) * USD_PER_MILLION_INPUT_TOKENS;

export const formatUsd = (usd: number): string =>
  usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
