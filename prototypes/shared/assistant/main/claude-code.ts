import { execFile, spawn } from "node:child_process";
import { promises as fs, constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ClaudeStatus, ChatEvent } from "../shared/types";
import type { ChatRequest } from "./remote-models";
import type { AgentTools } from "./agent-tools";
import { agentInstructions, chatHistory, imageLabel } from "./agent-context";
import { workspaceMcp, mcpServerName } from "./workspace-mcp";
import { textBlocks } from "./text-blocks";

import { claudeModels } from "./claude-discovery";
export { claudeModels, findClaude, claudeStatus } from "./claude-discovery";

export function claudeArguments(model: string, config: string, instructions: string, tools: AgentTools, images = false) {
  if (!claudeModels.some(item => item.id === model)) throw new Error("Choose a Claude model in Connections.");
  return ["--print", "--output-format", "stream-json", "--verbose", "--include-partial-messages", ...(images ? ["--input-format", "stream-json"] : []), "--restricted", "--tools", "", "--disable-slash-commands", "--strict-mcp-config", "--mcp-config", config, "--no-chrome", "--no-session-persistence", "--setting-sources", "", "--settings", JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false }), "--system-prompt-file", instructions, "--permission-mode", "dontAsk", "--max-turns", "100", ...(tools.definitions.length ? ["--allowedTools", tools.definitions.map(tool => `mcp__${mcpServerName}__${tool.function.name}`).join(",")] : []), ...(model !== "default" ? ["--model", model] : [])];
}

// CLI credentials stay under Claude Code's ownership. No SDK, token extraction,
// copied auth files, API fallback, or shell interpolation is involved.
export async function claudeChat(file: string, directory: string, request: ChatRequest, signal: AbortSignal, emit: (event: ChatEvent) => void, tools: AgentTools, timeoutMs = 2 * 60 * 60 * 1000) {
  signal.throwIfAborted();
  const turnController = new AbortController();
  const turnSignal = AbortSignal.any([signal, turnController.signal]);
  const bridge = await workspaceMcp(tools, turnSignal, name => emit({ id: request.id, activity: name }));
  let temp: string | undefined;
  try {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    temp = await fs.mkdtemp(path.join(directory, "turn-"));
    const config = path.join(temp, "mcp.json"), instructions = path.join(temp, "instructions.txt");
    await fs.writeFile(config, JSON.stringify(bridge.config), { mode: 0o600 });
    await fs.writeFile(instructions, agentInstructions(request.mode ?? "discuss", request.permission, request.environment), { mode: 0o600 });
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(file, claudeArguments(request.model, config, instructions, tools, !!request.images?.length), { cwd: temp, detached: process.platform !== "win32", windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, MCP_TOOL_TIMEOUT: String(timeoutMs) } });
      let buffer = "", bytes = 0, textSize = 0, streamed = false, result = false, failure: Error | undefined, finished = false;
      let force: ReturnType<typeof setTimeout> | undefined;
      const kill = (hard: boolean) => {
        if (!child.pid) return;
        if (process.platform === "win32") { const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); killer.on("error", () => child.kill()); }
        else { try { process.kill(-child.pid, hard ? "SIGKILL" : "SIGTERM"); } catch { /* Already exited. */ } }
      };
      const stop = (message: string) => {
        if (finished || failure) return;
        failure = new Error(message); turnController.abort(); kill(false);
        force = setTimeout(() => kill(true), 1000); force.unref();
      };
      const abort = () => stop("Reply stopped.");
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      const timeout = setTimeout(() => stop("Claude Code timed out. Retry manually; no other connection was used."), timeoutMs);
      const blocks = textBlocks(value => { textSize += value.length; if (textSize > 512000) stop("Claude Code output limit reached."); else emit({ id: request.id, delta: value }); });
      const delta = blocks.text;
      const line = (text: string) => {
        if (!text.trim() || failure) return;
        let event: any;
        try { event = JSON.parse(text); } catch { stop("Claude Code returned an invalid stream. Update it and retry."); return; }
        if (event.parent_tool_use_id) return;
        if (event.type === "system" && event.subtype === "init" && Array.isArray(event.mcp_servers) && tools.definitions.length) {
          // A dropped or failed bridge would otherwise yield a silent tool-less reply.
          const server = event.mcp_servers.find((item: any) => item?.name === mcpServerName);
          if (!server || server.status === "failed") { stop("Claude Code did not load this app's workspace tools. Update Claude Code and retry; no tools were run."); return; }
        }
        if (event.type === "system" && event.subtype === "init" && Array.isArray(event.tools)) {
          const allowed = new Set(["EndConversation", ...tools.definitions.map(tool => `mcp__${mcpServerName}__${tool.function.name}`)]);
          if (event.tools.some((tool: unknown) => typeof tool !== "string" || !allowed.has(tool))) { stop("Claude Code loaded tools outside this mode. The turn was stopped; check managed CLI settings."); return; }
        }
        if (event.type === "stream_event" && event.event?.type === "content_block_start") blocks.boundary();
        if (event.type === "stream_event" && event.event?.type === "message_start" && event.event.message?.usage) {
          const usage = event.event.message.usage;
          emit({ id: request.id, usage: { input: (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0) } });
        }
        if (event.type === "stream_event" && event.event?.type === "message_delta" && typeof event.event.usage?.output_tokens === "number") emit({ id: request.id, usage: { output: event.event.usage.output_tokens } });
        if (event.type === "stream_event" && event.event?.type === "content_block_delta" && event.event.delta?.type === "text_delta" && typeof event.event.delta.text === "string") { streamed = true; delta(event.event.delta.text); }
        if (event.type === "result") {
          if (event.is_error || event.subtype !== "success") { stop("Claude Code could not complete this turn. Check its sign-in, model access, usage limits, and connection. No API fallback was attempted."); return; }
          result = true;
          if (!streamed && typeof event.result === "string") delta(event.result);
        }
      };
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (failure) return;
        bytes += Buffer.byteLength(chunk); buffer += chunk;
        if (bytes > 8388608 || buffer.length > 1048576) { stop("Claude Code stream exceeded its size limit."); return; }
        let index: number;
        while ((index = buffer.indexOf("\n")) !== -1) { const next = buffer.slice(0, index); buffer = buffer.slice(index + 1); line(next); }
      });
      // Drain diagnostics without retaining or forwarding potentially sensitive CLI output.
      child.stderr.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 8388608) stop("Claude Code diagnostics exceeded the output limit."); });
      child.stdin.on("error", () => { /* Close/error handles early termination. */ });
      child.once("error", () => stop("Claude Code could not be started. Check the installation."));
      child.once("close", code => {
        line(buffer); finished = true; clearTimeout(timeout); signal.removeEventListener("abort", abort);
        if (!failure && force) clearTimeout(force);
        if (failure) reject(failure);
        else if (code !== 0 || !result) reject(new Error("Claude Code exited without a completed reply. Check its sign-in and installation."));
        else resolve();
      });
      const prompt = `Continue this conversation and answer the user's latest request. The JSON contains conversation history and shared reference context:\n${JSON.stringify(chatHistory(request.messages, request.context))}`;
      // Images need structured input; plain text otherwise.
      child.stdin.end(request.images?.length
        ? JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: `${prompt}\n\n${imageLabel}` }, ...request.images.map(image => ({ type: "image", source: { type: "base64", media_type: image.mime, data: image.data } }))] } }) + "\n"
        : prompt);
    });
  } finally { turnController.abort(); await bridge.close(); if (temp) await fs.rm(temp, { recursive: true, force: true }); }
}
