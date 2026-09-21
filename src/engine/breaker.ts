import { err } from "../util/result.ts";
import { verdictError, type ErrorCode } from "../util/errors.ts";
import type { DecisionEngine } from "./types.ts";

const CONSECUTIVE_FAILURE_LIMIT = 5;

/** Failures that will not fix themselves: stop spending requests on them. */
const FATAL: ReadonlySet<ErrorCode> = new Set(["engine_auth_failed"]);
const COUNTED: ReadonlySet<ErrorCode> = new Set([
  "engine_unavailable",
  "engine_timeout",
  "engine_rate_limited",
  "engine_response_invalid",
]);

/**
 * Opens after repeated provider failures so a dead key or an outage fails the run
 * loudly instead of marking every candidate as errored one request at a time.
 */
export const withCircuitBreaker = (engine: DecisionEngine): DecisionEngine => {
  let consecutive = 0;
  let open: string | null = null;

  return {
    id: engine.id,
    evaluate: async (request) => {
      if (open !== null) return err(verdictError("engine_circuit_open", open));
      const result = await engine.evaluate(request);
      if (result.ok) {
        consecutive = 0;
        return result;
      }
      if (FATAL.has(result.error.code)) {
        open = result.error.message;
      } else if (COUNTED.has(result.error.code)) {
        consecutive += 1;
        if (consecutive >= CONSECUTIVE_FAILURE_LIMIT) {
          open = `Engine failed ${consecutive} times in a row. Last error: ${result.error.message}`;
        }
      }
      return result;
    },
  };
};
