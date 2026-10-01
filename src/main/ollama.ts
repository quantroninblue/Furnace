import { agentInstructions, chatHistory } from "./agent-context";
import type { AgentMode, ChatEvent, Message } from "../shared/types";
import type { AgentTools } from "./agent-tools";

export const OLLAMA_URL = "http://127.0.0.1:11434";

export async function listModels(): Promise<string[]> {
  const response = await fetch(`${OLLAMA_URL}/api/tags`, {
    signal: AbortSignal.timeout(2500),
  });
  if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}.`);
  const data = (await response.json()) as { models?: { name: string }[] };
  return (data.models ?? []).map((model) => model.name);
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
};

export async function chat(
  request: {
    id: string;
    model: string;
    messages: Message[];
    context: string;
    mode?: AgentMode;
  },
  signal: AbortSignal,
  emit: (event: ChatEvent) => void,
  tools?: AgentTools,
) {
  const mode = request.mode ?? "discuss";
  const messages: ModelMessage[] = [
    { role: "system", content: agentInstructions(mode) },
    ...chatHistory(request.messages, request.context),
  ];
  let toolCount = 0;
  let outputSize = 0;
  for (let round = 0; round < 6; round++) {
    signal.throwIfAborted();
    const response = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: request.model,
        stream: true,
        messages,
        ...(tools?.definitions.length ? { tools: tools.definitions } : {}),
      }),
    });
    if (!response.ok || !response.body)
      throw new Error(
        `Ollama returned HTTP ${response.status}. Check the model and its tool-calling support.`,
      );
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
        message?: {
          content?: string;
          thinking?: string;
          tool_calls?: ToolCall[];
        };
      };
      if (event.error) throw new Error(event.error);
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
      }
      for (const call of message?.tool_calls ?? []) {
        if (!call.function || typeof call.function.name !== "string")
          throw new Error("Invalid model tool call.");
        const index = call.function.index;
        if (
          index !== undefined &&
          Number.isInteger(index) &&
          index >= 0 &&
          index < 16
        )
          calls[index] = call;
        else calls.push(call);
        if (calls.length > 16) throw new Error("Too many tool calls.");
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
      if (++toolCount > 16)
        throw new Error(
          "The agent reached its 16-tool turn limit. Send another message to continue.",
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
        content: result.slice(0, 32000),
      });
    }
    if (content) emit({ id: request.id, delta: "\n\n" });
  }
  throw new Error(
    "The agent reached its 6-step turn limit. Send another message to continue.",
  );
}
