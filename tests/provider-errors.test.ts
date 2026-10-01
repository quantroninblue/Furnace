import { test } from "node:test";
import assert from "node:assert/strict";
import OpenAI from "openai";
import { providerError } from "../src/main/provider-errors";

test("DNS, certificate, timeout and reset errors retain actionable causes without secrets", () => {
  const cases = [
    ["EAI_AGAIN", /DNS/],
    ["UNABLE_TO_GET_ISSUER_CERT_LOCALLY", /TLS certificate/],
    ["UND_ERR_HEADERS_TIMEOUT", /timed out/],
    ["ECONNRESET", /interrupted/],
  ] as const;
  for (const [code, expected] of cases) {
    const error = new OpenAI.APIConnectionError({ cause: new TypeError("sk-private-value", { cause: { code } }) });
    const result = providerError("openai", error).message;
    assert.match(result, expected);
    assert.doesNotMatch(result, /sk-private-value/);
  }
});
test("SSE errors without HTTP status still distinguish quota, access and input errors", () => {
  assert.match(providerError("openai", { error: { code: "insufficient_quota", message: "secret" } }).message, /credits or spending limit/);
  assert.match(providerError("openai", { code: "model_not_found" }).message, /denied access/);
  const invalid = providerError("openai", { status: 400, param: "reasoning.effort", message: "request body secret" }).message;
  assert.match(invalid, /reasoning.effort/);
  assert.doesNotMatch(invalid, /request body secret/);
  assert.doesNotMatch(providerError("openai", { status: 400, param: "sk-secret-value" }).message, /sk-secret/);
  assert.match(providerError("anthropic", { type: "overloaded_error" }).message, /service returned/);
});
test("AggregateError network causes are inspected and arbitrary messages are never forwarded", () => {
  const aggregate = new OpenAI.APIConnectionError({ cause: new AggregateError([{ code: "ENETUNREACH" }, { code: "ETIMEDOUT" }]) });
  assert.match(providerError("openai", aggregate).message, /timed out|interrupted/);
  assert.doesNotMatch(providerError("openai", new Error("Bearer sensitive-token")).message, /sensitive-token/);
  assert.match(providerError("openai", new SyntaxError("secret response")).message, /unreadable response/);
});
