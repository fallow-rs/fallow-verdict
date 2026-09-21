import type { Result } from "../util/result.ts";
import type { VerdictError } from "../util/errors.ts";

/** A yes/no question answered as a probability. Jev calls this primitive `noul`. */
export type NoulQuestion = {
  type: "noul";
  instructions: string;
  criteria: { true: string; false: string };
};

export type ChoiceQuestion = {
  type: "choice";
  instructions: string;
  /** Option id to its description. */
  criteria: Record<string, string>;
};

export type ScoreQuestion = {
  type: "score";
  instructions: string;
  /** Ordered levels, lowest first. */
  criteria: string[];
};

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export type NoulAnswer = { type: "noul"; probability: number };

export type ChoiceAnswer = {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};

export type ScoreAnswer = {
  type: "score";
  score: number;
  probabilities: number[];
  confidence: number;
};

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export type EvaluateRequest = {
  state: unknown;
  questions: Record<string, Question>;
  signal?: AbortSignal | undefined;
};

export type EvaluateResponse = {
  /** Concrete model version that answered, e.g. `jev-1.13.0`. */
  model: string;
  answers: Record<string, Answer>;
  inputTokens: number;
  latencyMs: number;
};

/**
 * A decision engine answers typed questions about a state. It returns
 * probabilities, never prose, and cannot answer outside the question schema.
 */
export type DecisionEngine = {
  id: string;
  evaluate: (request: EvaluateRequest) => Promise<Result<EvaluateResponse, VerdictError>>;
};
