import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { toResponseInputItems } from "openai/lib/responses/ResponseInputItems";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import type { MessageParam, ToolResultBlockParam } from "@anthropic-ai/sdk/resources/messages/messages";
import type { AgentMode, ChatEvent, Message, RemoteProvider } from "../shared/types";
import type { AgentTools } from "./agent-tools";
import { agentInstructions, chatHistory } from "./agent-context";

export type ChatRequest = { id: string; model: string; mode?: AgentMode; messages: Message[]; context: string };
export { providerError, providerName } from "./provider-errors";
import { providerError } from "./provider-errors";
function clients(provider: RemoteProvider, key: string, fetcher?: typeof fetch) {
  const common = { apiKey: key, maxRetries: 0, timeout: 180000, ...(fetcher ? { fetch: fetcher } : {}) };
  return provider === "openai"
    ? new OpenAI({ ...common, baseURL: "https://api.openai.com/v1" })
    : new Anthropic({ ...common, baseURL: "https://api.anthropic.com" });
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
  const client = clients(provider, key, fetcher);
  const errorProvider = options.chatgpt ? "chatgpt" : provider;
  const history = chatHistory(request.messages, request.context);
  const instructions = agentInstructions(request.mode ?? "discuss");
  let toolCount = 0, outputSize = 0;
  const delta = (text: string) => {
    outputSize += text.length;
    if (outputSize > 512000) throw new Error("Reply exceeded the output limit.");
    emit({ id: request.id, delta: text });
  };
  const execute = async (name: string, args: unknown) => {
    signal.throwIfAborted();
    if (++toolCount > 16) throw new Error("Tool limit reached. Continue with another message.");
    emit({ id: request.id, activity: name });
    try { return { output: (await tools.execute(name, args)).slice(0, 32000), error: false }; }
    catch (error) { return { output: String(error instanceof Error ? error.message : error).slice(0, 1000), error: true }; }
  };
  if (client instanceof OpenAI) {
    const input: ResponseInputItem[] = history;
    for (let round = 0; round < 6; round++) {
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
          if (event.type === "response.output_text.delta" || event.type === "response.refusal.delta") delta(event.delta);
        }
        response = await stream.finalResponse();
      } catch (error) { stream.abort(); if (signal.aborted) throw error; throw providerError(errorProvider, error); }
      if (response.status === "failed" && response.error) throw providerError(errorProvider, response.error);
      if (response.status !== "completed") throw new Error("OpenAI stopped before completing this turn. No incomplete tool calls were applied; try a smaller request.");
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
    for (let round = 0; round < 6; round++) {
      signal.throwIfAborted();
      const stream = client.messages.stream({
        model: request.model, system: instructions, messages, max_tokens: 16384,
        ...(tools.definitions.length ? { tools: tools.definitions.map(tool => ({ name: tool.function.name, description: tool.function.description, input_schema: tool.function.parameters })) } : {}),
      }, { signal });
      let response;
      try {
        for await (const event of stream) if (event.type === "content_block_delta" && event.delta.type === "text_delta") delta(event.delta.text);
        response = await stream.finalMessage();
      } catch (error) { stream.abort(); if (signal.aborted) throw error; throw providerError(provider, error); }
      if (!["end_turn", "tool_use", "stop_sequence"].includes(response.stop_reason ?? "")) throw new Error("Anthropic stopped before completing this turn. Try a smaller request.");
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
