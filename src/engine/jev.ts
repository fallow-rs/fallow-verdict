import { z } from "zod";

import { err, ok, type Result } from "../util/result.ts";
import { verdictError, type VerdictError } from "../util/errors.ts";
import type {
  Answer,
  DecisionEngine,
  EvaluateRequest,
  EvaluateResponse,
  Question,
} from "./types.ts";

const DEFAULT_BASE_URL = "https://api.typesafe.ai/v1";
const DEFAULT_MODEL = "jev-latest";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
const BACKOFF_INITIAL_MS = 500;
const BACKOFF_MAX_MS = 5_000;
const BACKOFF_JITTER = 0.25;
const MAX_RETRY_AFTER_MS = 60_000;

export type JevOptions = {
  apiKey: string;
  baseUrl?: string | undefined;
  model?: string | undefined;
  timeoutMs?: number | undefined;
  /** Transport override for tests and proxies. */
  fetch?: typeof globalThis.fetch | undefined;
};

const probability = z.number().min(0).max(1);

const answerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), noul: probability }),
  z.object({
    type: z.literal("choice"),
    choice: z.string(),
    probabilities: z.record(z.string(), probability),
    confidence: probability,
  }),
  z.object({
    type: z.literal("score"),
    score: z.number(),
    probabilities: z.record(z.string(), probability),
    confidence: probability,
  }),
]);

const responseSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), answerSchema),
  usage: z.object({ input_tokens: z.number() }),
});

type WireAnswer = z.infer<typeof answerSchema>;

const toAnswer = (wire: WireAnswer): Answer => {
  if (wire.type === "noul") return { type: "noul", probability: wire.noul };
  if (wire.type === "choice") return wire;
  const levels = Object.keys(wire.probabilities).length;
  const probabilities = Array.from(
    { length: levels },
    (_unused, index) => wire.probabilities[String(index)] ?? 0,
  );
  return { type: "score", score: wire.score, probabilities, confidence: wire.confidence };
};

/**
 * The engine answers only what was asked, in the shape that was asked. Anything
 * else is a malformed response, not a partial success.
 */
const alignAnswers = (
  questions: Record<string, Question>,
  wire: Record<string, WireAnswer>,
): Result<Record<string, Answer>, VerdictError> => {
  const answers: Record<string, Answer> = {};
  for (const [id, question] of Object.entries(questions)) {
    const answer = wire[id];
    if (answer === undefined || answer.type !== question.type) {
      return err(
        verdictError(
          "engine_response_invalid",
          `Engine response is missing a ${question.type} answer for \`${id}\`.`,
        ),
      );
    }
    if (
      answer.type === "choice" &&
      !(answer.choice in (question as { criteria: object }).criteria)
    ) {
      return err(
        verdictError("engine_response_invalid", `Engine chose an unknown option for \`${id}\`.`),
      );
    }
    answers[id] = toAnswer(answer);
  }
  return ok(answers);
};

const classifyStatus = (status: number, body: string): VerdictError => {
  const detail = body.slice(0, 300);
  if (status === 401 || status === 403) {
    return verdictError(
      "engine_auth_failed",
      `Jev rejected the API key (HTTP ${status}).`,
      "Set TYPESAFE_API_KEY to a valid key.",
    );
  }
  if (status === 429) return verdictError("engine_rate_limited", `Jev rate limit hit: ${detail}`);
  if (status === 400 || status === 404 || status === 413 || status === 422) {
    return verdictError("engine_rejected", `Jev rejected the request (HTTP ${status}): ${detail}`);
  }
  return verdictError("engine_unavailable", `Jev returned HTTP ${status}: ${detail}`);
};

const RETRYABLE: ReadonlySet<VerdictError["code"]> = new Set([
  "engine_rate_limited",
  "engine_unavailable",
  "engine_timeout",
]);

const backoffMs = (attempt: number, retryAfter: string | null): number => {
  const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
  if (Number.isFinite(seconds)) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  const base = Math.min(BACKOFF_INITIAL_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS);
  return base * (1 + (Math.random() * 2 - 1) * BACKOFF_JITTER);
};

const sleep = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });

export const createJevEngine = (options: JevOptions): DecisionEngine => {
  const send = options.fetch ?? globalThis.fetch;
  const url = `${(options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "")}/systemone`;
  const model = options.model ?? DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const attemptOnce = async (
    request: EvaluateRequest,
  ): Promise<{ result: Result<EvaluateResponse, VerdictError>; retryAfter: string | null }> => {
    const started = performance.now();
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    try {
      const response = await send(url, {
        method: "POST",
        headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model, state: request.state, questions: request.questions }),
        signal,
      });
      const retryAfter = response.headers.get("retry-after");
      if (!response.ok) {
        const body = (await response.text()).replaceAll(options.apiKey, "[REDACTED]");
        return { result: err(classifyStatus(response.status, body)), retryAfter };
      }
      const parsed = responseSchema.safeParse(await response.json());
      if (!parsed.success) {
        return {
          result: err(verdictError("engine_response_invalid", z.prettifyError(parsed.error))),
          retryAfter,
        };
      }
      const answers = alignAnswers(request.questions, parsed.data.answers);
      if (!answers.ok) return { result: answers, retryAfter };
      return {
        result: ok({
          model: parsed.data.model,
          answers: answers.data,
          inputTokens: parsed.data.usage.input_tokens,
          latencyMs: Math.round(performance.now() - started),
        }),
        retryAfter,
      };
    } catch (cause) {
      if (request.signal?.aborted) {
        return { result: err(verdictError("interrupted", "Interrupted.")), retryAfter: null };
      }
      const timedOut = cause instanceof Error && cause.name === "TimeoutError";
      return {
        result: err(
          timedOut
            ? verdictError("engine_timeout", `Jev did not answer within ${timeoutMs} ms.`)
            : verdictError(
                "engine_unavailable",
                cause instanceof Error ? cause.message : String(cause),
              ),
        ),
        retryAfter: null,
      };
    }
  };

  return {
    id: `jev:${model}`,
    evaluate: async (request) => {
      for (let attempt = 1; ; attempt += 1) {
        if (request.signal?.aborted) return err(verdictError("interrupted", "Interrupted."));
        const { result, retryAfter } = await attemptOnce(request);
        if (result.ok || !RETRYABLE.has(result.error.code) || attempt === MAX_ATTEMPTS) {
          return result;
        }
        await sleep(backoffMs(attempt, retryAfter), request.signal);
      }
    },
  };
};
