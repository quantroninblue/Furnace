import { agentInstructions, chatHistory, imageLabel } from "./agent-context";
import { OLLAMA_CONTEXT } from "./context-window";
import type { AgentMode, ChatEvent, ImageInput, Message } from "../shared/types";
import type { AgentTools } from "./agent-tools";
import { MAX_ROUNDS, MAX_TOOL_CALLS } from "./remote-models";

export const OLLAMA_URL = "http://127.0.0.1:11434";

export async function listModels(): Promise<string[]> {
  const response = await fetch(`${OLLAMA_URL}/api/tags`, {
    signal: AbortSignal.timeout(2500),
  });
  if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}.`);
  const data = (await response.json()) as { models?: { name: string }[] };
  return (data.models ?? []).map((model) => model.name);
}

/** What a local model can do ("vision", "tools", "thinking" …), from Ollama's model details; null when unknown. */
export async function capabilities(model: string): Promise<string[] | null> {
  return (await showModel(model))?.capabilities ?? null;
}

/** Ollama's details for a model: capabilities, parameter size (e.g. "14.8B") and family; null when unknown. */
export async function showModel(model: string): Promise<{ capabilities: string[] | null; size?: string; family?: string } | null> {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { capabilities?: unknown; details?: { parameter_size?: unknown; family?: unknown } };
    const text = (value: unknown) => typeof value === "string" && value.length <= 40 ? value : undefined;
    return {
      capabilities: Array.isArray(data.capabilities) ? data.capabilities.filter((item): item is string => typeof item === "string") : null,
      size: text(data.details?.parameter_size), family: text(data.details?.family),
    };
  } catch {
    return null;
  }
}

type ToolCall = {
  function: { name: string; arguments: unknown; index?: number };
};
type ModelMessage = {
  role: string;
  content: string;
  thinking?: string;
  tool_calls?: ToolCall[];
  tool_name?: string;
  images?: string[];
};

export async function chat(
  request: {
    id: string;
    model: string;
    messages: Message[];
    context: string;
    mode?: AgentMode;
    permission?: "ask" | "auto" | "full";
    environment?: string;
    autocompute?: string;
    images?: ImageInput[];
  },
  signal: AbortSignal,
  emit: (event: ChatEvent) => void,
  tools?: AgentTools,
) {
  const mode = request.mode ?? "discuss";
  const messages: ModelMessage[] = [
    { role: "system", content: agentInstructions(mode, request.permission, request.environment, request.autocompute) },
    ...chatHistory(request.messages, request.context),
    ...(request.images?.length ? [{ role: "user", content: imageLabel, images: request.images.map(image => image.data) }] : []),
  ];
  let toolCount = 0;
  let outputSize = 0;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    signal.throwIfAborted();
    const response = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: request.model,
        stream: true,
        messages,
        // Ollama's default context is too small for agent instructions and tools.
        options: { num_ctx: OLLAMA_CONTEXT },
        ...(tools?.definitions.length ? { tools: tools.definitions } : {}),
      }),
    });
    if (!response.ok || !response.body) {
      // Ollama explains a refusal (no image or tool support, unknown model) in the body.
      const body = await response.text().catch(() => "");
      let detail = body;
      try { detail = String((JSON.parse(body) as { error?: unknown }).error ?? body); } catch { /* Plain text. */ }
      detail = detail.trim().slice(0, 300);
      throw new Error(`Ollama returned HTTP ${response.status}${detail ? `: ${detail}` : "."}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let thinking = "";
    const calls: ToolCall[] = [];
    const consume = (line: string) => {
      if (!line.trim()) return;
      const event = JSON.parse(line) as {
        error?: string;
        done?: boolean;
        prompt_eval_count?: number;
        eval_count?: number;
        message?: {
          content?: string;
          thinking?: string;
          tool_calls?: ToolCall[];
        };
      };
      if (event.error) throw new Error(event.error);
      if (event.done && (event.prompt_eval_count || event.eval_count)) emit({ id: request.id, usage: { input: event.prompt_eval_count, output: event.eval_count } });
      const message = event.message;
      if (message?.content) {
        outputSize += message.content.length;
        if (outputSize > 512000)
          throw new Error("Reply exceeded the output limit.");
        content += message.content;
        emit({ id: request.id, delta: message.content });
      }
      if (message?.thinking) {
        thinking += message.thinking;
        if (thinking.length > 256000)
          throw new Error("Model reasoning exceeded the turn limit.");
        emit({ id: request.id, thinking: message.thinking });
      }
      for (const call of message?.tool_calls ?? []) {
        if (!call.function || typeof call.function.name !== "string")
          throw new Error("Invalid model tool call.");
        const index = call.function.index;
        if (
          index !== undefined &&
          Number.isInteger(index) &&
          index >= 0 &&
          index < 32
        )
          calls[index] = call;
        else calls.push(call);
        if (calls.length > 32) throw new Error("Too many tool calls.");
      }
    };
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index: number;
        while ((index = buffer.indexOf("\n")) !== -1) {
          consume(buffer.slice(0, index));
          buffer = buffer.slice(index + 1);
        }
        if (buffer.length > 1024 * 1024)
          throw new Error("Ollama sent an oversized response chunk.");
      }
      buffer += decoder.decode();
      consume(buffer);
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
    const toolCalls = calls.filter(Boolean);
    if (!toolCalls.length) return;
    messages.push({
      role: "assistant",
      content,
      ...(thinking ? { thinking } : {}),
      tool_calls: toolCalls,
    });
    for (const call of toolCalls) {
      signal.throwIfAborted();
      if (++toolCount > MAX_TOOL_CALLS)
        throw new Error(
          "The agent reached its tool-call limit for this turn. Send another message to continue.",
        );
      emit({ id: request.id, activity: call.function.name });
      let result: string;
      try {
        if (!tools) throw new Error("No tools are allowed in this mode.");
        result = await tools.execute(
          call.function.name,
          call.function.arguments,
        );
      } catch (error) {
        result = JSON.stringify({
          error: String(error instanceof Error ? error.message : error),
        });
      }
      messages.push({
        role: "tool",
        tool_name: call.function.name,
        content: result.slice(0, 64000),
      });
    }
    if (content) emit({ id: request.id, delta: "\n\n" });
  }
  throw new Error(
    "The agent reached its 6-step turn limit. Send another message to continue.",
  );
}
