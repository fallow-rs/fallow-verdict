import { describe, expect, it } from "vitest";

import { withCircuitBreaker } from "../src/engine/breaker.ts";
import { createJevEngine } from "../src/engine/jev.ts";
import type { DecisionEngine } from "../src/engine/types.ts";
import { QUESTIONS } from "../src/questions/catalog.ts";
import { verdictError } from "../src/util/errors.ts";
import { err } from "../src/util/result.ts";

const wireAnswers = {
  attacker_controlled: { type: "noul", noul: 0.95 },
  reaches_sink: { type: "noul", noul: 0.9 },
  mitigated: { type: "noul", noul: 0.05 },
  exploitable: { type: "noul", noul: 0.93 },
  non_production: { type: "noul", noul: 0.01 },
  tampering: { type: "noul", noul: 0.02 },
  impact: {
    type: "score",
    score: 2.7,
    probabilities: { "0": 0, "1": 0.1, "2": 0.1, "3": 0.8 },
    confidence: 0.7,
  },
  fix_direction: {
    type: "choice",
    choice: "validate-input",
    probabilities: { "validate-input": 0.8, none: 0.2 },
    confidence: 0.75,
  },
};

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers });

const okBody = (answers: unknown = wireAnswers) => ({
  model: "jev-1.13.0",
  answers,
  usage: { input_tokens: 1234, output_tokens: 20 },
});

const engineWith = (responses: Response[]) => {
  const requests: { url: string; init: RequestInit }[] = [];
  const engine = createJevEngine({
    apiKey: "test-key",
    fetch: (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      const next = responses.shift();
      return next ? Promise.resolve(next) : Promise.reject(new Error("no more responses"));
    },
  });
  return { engine, requests };
};

const request = { state: { code: "x" }, questions: QUESTIONS };

describe("createJevEngine", () => {
  it("posts state and questions with bearer auth and maps the answers", async () => {
    const { engine, requests } = engineWith([json(200, okBody())]);
    const result = await engine.evaluate(request);

    expect(requests[0]?.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(new Headers(requests[0]?.init.headers).get("authorization")).toBe("Bearer test-key");
    expect(JSON.parse(String(requests[0]?.init.body))).toMatchObject({
      model: "jev-latest",
      state: { code: "x" },
    });
    expect(result).toMatchObject({
      ok: true,
      data: {
        model: "jev-1.13.0",
        inputTokens: 1234,
        answers: {
          exploitable: { type: "noul", probability: 0.93 },
          impact: { type: "score", probabilities: [0, 0.1, 0.1, 0.8] },
        },
      },
    });
  });

  it("retries an overloaded engine and honors retry-after", async () => {
    const { engine, requests } = engineWith([
      json(529, { error: "overloaded" }, { "retry-after": "0" }),
      json(200, okBody()),
    ]);
    expect((await engine.evaluate(request)).ok).toBe(true);
    expect(requests).toHaveLength(2);
  });

  it("does not retry a rejected key", async () => {
    const { engine, requests } = engineWith([json(401, { error: "bad key" }), json(200, okBody())]);
    expect(await engine.evaluate(request)).toMatchObject({
      ok: false,
      error: { code: "engine_auth_failed" },
    });
    expect(requests).toHaveLength(1);
  });

  it("rejects a response that skips a question instead of guessing", async () => {
    const { exploitable: _dropped, ...partial } = wireAnswers;
    const { engine } = engineWith([json(200, okBody(partial))]);
    expect(await engine.evaluate(request)).toMatchObject({
      ok: false,
      error: { code: "engine_response_invalid" },
    });
  });

  it("rejects a choice outside the offered options", async () => {
    const tampered = {
      ...wireAnswers,
      fix_direction: { ...wireAnswers.fix_direction, choice: "ignore-this" },
    };
    const { engine } = engineWith([json(200, okBody(tampered))]);
    expect(await engine.evaluate(request)).toMatchObject({
      ok: false,
      error: { code: "engine_response_invalid" },
    });
  });
});

const failing = (
  code: "engine_auth_failed" | "engine_unavailable",
): DecisionEngine & { calls: number } => {
  const engine = {
    id: "failing",
    calls: 0,
    evaluate: () => {
      engine.calls += 1;
      return Promise.resolve(err(verdictError(code, "down")));
    },
  };
  return engine;
};

describe("withCircuitBreaker", () => {
  it("opens immediately on an auth failure", async () => {
    const inner = failing("engine_auth_failed");
    const engine = withCircuitBreaker(inner);
    await engine.evaluate(request);
    expect(await engine.evaluate(request)).toMatchObject({
      ok: false,
      error: { code: "engine_circuit_open" },
    });
    expect(inner.calls).toBe(1);
  });

  it("opens after repeated provider failures", async () => {
    const inner = failing("engine_unavailable");
    const engine = withCircuitBreaker(inner);
    for (let index = 0; index < 8; index += 1) await engine.evaluate(request);
    expect(inner.calls).toBe(5);
  });
});
