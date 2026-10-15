import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { toResponseInputItems } from "openai/lib/responses/ResponseInputItems";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import type { MessageParam, ToolResultBlockParam } from "@anthropic-ai/sdk/resources/messages/messages";
import type { AgentMode, ChatEvent, ImageInput, Message, RemoteProvider } from "../shared/types";
import type { AgentTools } from "./agent-tools";
import { agentInstructions, chatHistory, imageLabel } from "./agent-context";

export type ChatRequest = { id: string; model: string; mode?: AgentMode; permission?: "ask" | "auto" | "full"; environment?: string; autocompute?: string; messages: Message[]; context: string; images?: ImageInput[] };
export { providerError, providerName } from "./provider-errors";
import { providerError } from "./provider-errors";
import { textBlocks } from "./text-blocks";

// Agentic turns: enough room for multi-file work; Stop always cancels.
export const MAX_ROUNDS = 100, MAX_TOOL_CALLS = 250;
function clients(provider: RemoteProvider, key: string, fetcher?: typeof fetch, onLimits?: (limits: Limits) => void) {
  const base = fetcher ?? fetch;
  // Rate-limit (and ChatGPT plan) headers ride along on every response.
  const watched: typeof fetch = onLimits ? async (input, init) => { const response = await base(input, init); const limits = readLimits(response.headers); if (limits) onLimits(limits); return response; } : base;
  const common = { apiKey: key, maxRetries: 0, timeout: 180000, ...(fetcher || onLimits ? { fetch: watched } : {}) };
  return provider === "openai"
    ? new OpenAI({ ...common, baseURL: "https://api.openai.com/v1" })
    : new Anthropic({ ...common, baseURL: "https://api.anthropic.com" });
}
/** What a provider reported about its limits on the latest response (all optional). */
export type Limits = {
  tokens?: { limit?: number; remaining?: number; reset?: string };
  requests?: { limit?: number; remaining?: number; reset?: string };
  /** ChatGPT plan windows, as the Codex backend reports them. */
  plan?: { window: "primary" | "secondary"; usedPercent: number; windowMinutes?: number; resetSeconds?: number }[];
};
const number = (value: string | null) => value !== null && value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : undefined;
export function readLimits(headers: Headers): Limits | null {
  const limits: Limits = {};
  for (const [kind, openai, anthropic] of [["tokens", "tokens", "tokens"], ["requests", "requests", "requests"]] as const) {
    const limit = number(headers.get(`x-ratelimit-limit-${openai}`) ?? headers.get(`anthropic-ratelimit-${anthropic}-limit`));
    const remaining = number(headers.get(`x-ratelimit-remaining-${openai}`) ?? headers.get(`anthropic-ratelimit-${anthropic}-remaining`));
    const reset = headers.get(`x-ratelimit-reset-${openai}`) ?? headers.get(`anthropic-ratelimit-${anthropic}-reset`) ?? undefined;
    if (limit !== undefined || remaining !== undefined) limits[kind] = { limit, remaining, reset: reset?.slice(0, 40) };
  }
  for (const window of ["primary", "secondary"] as const) {
    const usedPercent = number(headers.get(`x-codex-${window}-used-percent`));
    if (usedPercent !== undefined) (limits.plan ??= []).push({ window, usedPercent, windowMinutes: number(headers.get(`x-codex-${window}-window-minutes`)), resetSeconds: number(headers.get(`x-codex-${window}-reset-after-seconds`)) });
  }
  return Object.keys(limits).length ? limits : null;
}

/**
 * Input tokens of a request's first model call, counted by the provider's own tokenizer
 * (OpenAI responses/input_tokens, Anthropic count_tokens; neither is billed).
 */
export async function remoteCount(provider: RemoteProvider, key: string, request: ChatRequest, tools: AgentTools["definitions"], fetcher?: typeof fetch) {
  const client = clients(provider, key, fetcher);
  const history = chatHistory(request.messages, request.context);
  const instructions = agentInstructions(request.mode ?? "discuss", request.permission, request.environment, request.autocompute);
  const signal = AbortSignal.timeout(20000);
  try {
    if (client instanceof OpenAI) {
      const result = await client.responses.inputTokens.count({ model: request.model, instructions, input: history,
        ...(tools.length ? { tools: tools.map(tool => ({ type: "function" as const, ...tool.function, strict: true })) } : {}) }, { signal });
      return result.input_tokens;
    }
    const result = await client.messages.countTokens({ model: request.model, system: instructions, messages: history,
      ...(tools.length ? { tools: tools.map(tool => ({ name: tool.function.name, description: tool.function.description, input_schema: tool.function.parameters })) } : {}) }, { signal });
    return result.input_tokens;
  } catch (error) { throw providerError(provider, error); }
}

/**
 * Month-to-date organization spend in US dollars, read with an admin key (the only way the
 * providers report spend; neither exposes a remaining credit balance to API keys).
 */
export async function organizationSpend(provider: RemoteProvider, adminKey: string, since: Date, fetcher: typeof fetch = fetch) {
  let total = 0, page: string | undefined;
  for (let round = 0; round < 6; round++) {
    const url = provider === "openai"
      ? new URL("https://api.openai.com/v1/organization/costs")
      : new URL("https://api.anthropic.com/v1/organizations/cost_report");
    if (provider === "openai") { url.searchParams.set("start_time", String(Math.floor(since.getTime() / 1000))); url.searchParams.set("bucket_width", "1d"); }
    else url.searchParams.set("starting_at", since.toISOString());
    url.searchParams.set("limit", "31");
    if (page) url.searchParams.set("page", page);
    const response = await fetcher(url, { redirect: "error", signal: AbortSignal.timeout(20000),
      headers: provider === "openai" ? { Authorization: `Bearer ${adminKey}` } : { "x-api-key": adminKey, "anthropic-version": "2023-06-01" } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw providerError(provider, { status: response.status, error: body.error });
    for (const bucket of Array.isArray(body.data) ? body.data : []) for (const item of Array.isArray(bucket?.results) ? bucket.results : []) {
      // OpenAI: { amount: { value, currency } } in dollars; Anthropic: amount as a decimal string in cents.
      const value = provider === "openai" ? Number(item?.amount?.value) : Number(item?.amount) / 100;
      if (Number.isFinite(value)) total += value;
    }
    if (!body.has_more || typeof body.next_page !== "string") break;
    page = body.next_page;
  }
  return Math.round(total * 100) / 100;
}

export async function remoteModels(provider: RemoteProvider, key: string, fetcher?: typeof fetch) {
  const client = clients(provider, key, fetcher);
  const models: { id: string; name: string }[] = [];
  try {
    for await (const model of client.models.list({}, { signal: AbortSignal.timeout(15000) })) {
      if (provider === "openai" && (!/^(gpt-|o[134](?:-|$)|chatgpt-)/.test(model.id) || /image|audio|realtime|transcribe|tts|search|deep-research|instruct/.test(model.id))) continue;
      models.push({ id: model.id, name: "display_name" in model && typeof model.display_name === "string" ? model.display_name : model.id });
      if (models.length >= 300) break;
    }
  } catch (error) { throw providerError(provider, error); }
  return models.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })).reverse();
}

export async function chatgptModels(token: string, fetcher: typeof fetch = fetch): Promise<{ id: string; name: string }[]> {
  try {
    const response = await fetcher("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(15000) });
    const body = await response.json();
    if (!response.ok) throw { status: response.status, error: body.error };
    if (!Array.isArray(body.models)) throw new Error("Invalid catalog");
    return body.models.filter((item: any) => item?.visibility === "list" && typeof item.slug === "string" && item.slug.length <= 200 && typeof item.display_name === "string")
      .slice(0, 300).map((item: any) => ({ id: item.slug as string, name: item.display_name.slice(0, 200) as string }));
  } catch (error) { throw providerError("chatgpt", error); }
}

export async function remoteChat(provider: RemoteProvider, key: string, request: ChatRequest, signal: AbortSignal, emit: (event: ChatEvent) => void, tools: AgentTools, fetcher?: typeof fetch, options: { chatgpt?: boolean } = {}) {
  const client = clients(provider, key, fetcher, limits => emit({ id: request.id, limits }));
  const errorProvider = options.chatgpt ? "chatgpt" : provider;
  const history = chatHistory(request.messages, request.context);
  const instructions = agentInstructions(request.mode ?? "discuss", request.permission, request.environment, request.autocompute);
  let toolCount = 0, outputSize = 0;
  const blocks = textBlocks(text => {
    outputSize += text.length;
    if (outputSize > 512000) throw new Error("Reply exceeded the output limit.");
    emit({ id: request.id, delta: text });
  });
  const delta = blocks.text;
  const execute = async (name: string, args: unknown) => {
    signal.throwIfAborted();
    if (++toolCount > MAX_TOOL_CALLS) throw new Error("Tool limit reached. Continue with another message.");
    emit({ id: request.id, activity: name });
    try { return { output: (await tools.execute(name, args)).slice(0, 64000), error: false }; }
    catch (error) { return { output: String(error instanceof Error ? error.message : error).slice(0, 1000), error: true }; }
  };
  if (client instanceof OpenAI) {
    const input: ResponseInputItem[] = history;
    if (request.images?.length) input.push({ role: "user", content: [{ type: "input_text", text: imageLabel }, ...request.images.map(image => ({ type: "input_image" as const, detail: "auto" as const, image_url: `data:${image.mime};base64,${image.data}` }))] });
    for (let round = 0; round < MAX_ROUNDS; round++) {
      signal.throwIfAborted();
      const stream = client.responses.stream({
        model: request.model, instructions, input, store: false,
        include: ["reasoning.encrypted_content"], ...(options.chatgpt ? {} : { max_output_tokens: 16384 }),
        ...(tools.definitions.length ? { tools: options.chatgpt
          ? [{ type: "namespace" as const, name: "workspace", description: "User-controlled workspace tools for the selected mode.", tools: tools.definitions.map(tool => ({ type: "function" as const, ...tool.function, strict: true })) }]
          : tools.definitions.map(tool => ({ type: "function" as const, ...tool.function, strict: true })) } : {}),
      }, { signal });
      let response;
      try {
        for await (const event of stream) {
          if (event.type === "response.content_part.added") blocks.boundary();
          if (event.type === "response.output_text.delta" || event.type === "response.refusal.delta") delta(event.delta);
        }
        response = await stream.finalResponse();
      } catch (error) { stream.abort(); if (signal.aborted) throw error; throw providerError(errorProvider, error); }
      if (response.status === "failed" && response.error) throw providerError(errorProvider, response.error);
      if (response.status !== "completed") throw new Error("OpenAI stopped before completing this turn. No incomplete tool calls were applied; try a smaller request.");
      if (response.usage) emit({ id: request.id, usage: { input: response.usage.input_tokens, output: response.usage.output_tokens } });
      input.push(...toResponseInputItems(response.output));
      const calls = response.output.filter(item => item.type === "function_call");
      if (!calls.length) return;
      for (const call of calls) {
        if (options.chatgpt && call.namespace !== "workspace") throw new Error("The model requested an unknown tool namespace. No tool was run.");
        let args: unknown;
        try { args = JSON.parse(call.arguments); } catch { args = null; }
        const result = await execute(call.name, args);
        input.push({ type: "function_call_output", call_id: call.call_id, output: result.output });
      }
    }
  } else {
    const messages: MessageParam[] = history;
    if (request.images?.length) messages.push({ role: "user", content: [{ type: "text", text: imageLabel }, ...request.images.map(image => ({ type: "image" as const, source: { type: "base64" as const, media_type: image.mime as "image/png", data: image.data } }))] });
    for (let round = 0; round < MAX_ROUNDS; round++) {
      signal.throwIfAborted();
      const stream = client.messages.stream({
        model: request.model, system: instructions, messages, max_tokens: 16384,
        ...(tools.definitions.length ? { tools: tools.definitions.map(tool => ({ name: tool.function.name, description: tool.function.description, input_schema: tool.function.parameters })) } : {}),
      }, { signal });
      let response;
      try {
        for await (const event of stream) {
          if (event.type === "content_block_start") blocks.boundary();
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") delta(event.delta.text);
        }
        response = await stream.finalMessage();
      } catch (error) { stream.abort(); if (signal.aborted) throw error; throw providerError(provider, error); }
      if (!["end_turn", "tool_use", "stop_sequence"].includes(response.stop_reason ?? "")) throw new Error("Anthropic stopped before completing this turn. Try a smaller request.");
      emit({ id: request.id, usage: { input: response.usage.input_tokens + (response.usage.cache_creation_input_tokens ?? 0) + (response.usage.cache_read_input_tokens ?? 0), output: response.usage.output_tokens } });
      // Preserve signed thinking blocks and the original tool-use IDs for the next round.
      messages.push({ role: "assistant", content: response.content });
      const calls = response.content.filter(block => block.type === "tool_use");
      if (!calls.length) return;
      const results: ToolResultBlockParam[] = [];
      for (const call of calls) {
        const result = await execute(call.name, call.input);
        results.push({ type: "tool_result", tool_use_id: call.id, content: result.output, is_error: result.error });
      }
      messages.push({ role: "user", content: results });
    }
  }
  throw new Error("Agent turn limit reached. Continue with another message.");
}
