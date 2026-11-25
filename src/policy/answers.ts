import type { Answer } from "../engine/types.ts";

/** The probability of a yes/no answer, or null when the answer is missing or invalid. */
export const noulOf = (answers: Record<string, Answer>, id: string): number | null => {
  const answer = answers[id];
  return answer?.type === "noul" && Number.isFinite(answer.probability) ? answer.probability : null;
};
