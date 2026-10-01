import { execFile, spawn } from "node:child_process";
import { promises as fs, constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ClaudeStatus, ChatEvent } from "../shared/types";
import type { ChatRequest } from "./remote-models";
import type { AgentTools } from "./agent-tools";
import { agentInstructions, chatHistory } from "./agent-context";
import { workspaceMcp } from "./workspace-mcp";

export const claudeModels = [{ id: "default", name: "Claude Code default" }, { id: "sonnet", name: "Sonnet" }, { id: "opus", name: "Opus" }, { id: "fable", name: "Fable" }, { id: "haiku", name: "Haiku" }];
export async function findClaude() {
  const executable = process.platform === "win32" ? "claude.exe" : "claude";
  const directories = [...(process.env.PATH ?? "").split(path.delimiter), path.join(os.homedir(), ".local", "bin")];
  for (const directory of directories) {
    if (!path.isAbsolute(directory)) continue;
    const file = path.join(directory, executable);
    try { await fs.access(file, process.platform === "win32" ? constants.F_OK : constants.X_OK); if ((await fs.stat(file)).isFile()) return file; } catch { /* Try the next installation. */ }
  }
  return null;
}
function inspect(file: string, args: string[], cwd: string) {
  return new Promise<string>((resolve, reject) => {
    execFile(file, args, { cwd, timeout: 10000, maxBuffer: 65536, windowsHide: true }, (error, stdout) => {
      // Status exits 1 when signed out. No stderr or raw diagnostics enter IPC.
      if (error && !(error.code === 1 && args[0] === "auth")) reject(new Error("Claude Code did not respond. Check its installation and try again."));
      else resolve(stdout);
    });
  });
}
export async function claudeStatus(file: string | null, cwd: string): Promise<ClaudeStatus> {
  if (!file) return { installed: false, compatible: false, connected: false, models: [] };
  try {
    const raw = await inspect(file, ["--version"], cwd);
    const match = /\b(\d+)\.(\d+)\.(\d+)\b/.exec(raw);
    const compatible = !!match && (+match[1] > 2 || (+match[1] === 2 && (+match[2] > 1 || (+match[2] === 1 && +match[3] >= 248))));
    if (!compatible) return { installed: true, compatible: false, connected: false, models: [], version: match?.[0], error: "Update Claude Code to 2.1.248 or newer for restricted workspace integration." };
    const auth = JSON.parse(await inspect(file, ["auth", "status"], cwd));
    const label = (value: unknown) => typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 120) : undefined;
    return { installed: true, compatible: true, connected: auth.loggedIn === true, version: match![0], account: label(auth.email), authMethod: label(auth.authMethod), models: auth.loggedIn === true ? claudeModels : [] };
  } catch (error) { return { installed: true, compatible: false, connected: false, models: [], error: error instanceof SyntaxError ? "Claude Code returned an unreadable auth status. Update it and retry." : (error as Error).message }; }
}

export function claudeArguments(model: string, config: string, instructions: string, tools: AgentTools) {
  if (!claudeModels.some(item => item.id === model)) throw new Error("Choose a Claude model in Connections.");
  return ["--print", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--restricted", "--tools", "", "--disable-slash-commands", "--strict-mcp-config", "--mcp-config", config, "--no-chrome", "--no-session-persistence", "--setting-sources", "", "--settings", JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false }), "--system-prompt-file", instructions, "--permission-mode", "dontAsk", "--max-turns", "6", ...(tools.definitions.length ? ["--allowedTools", tools.definitions.map(tool => `mcp__workspace__${tool.function.name}`).join(",")] : []), ...(model !== "default" ? ["--model", model] : [])];
}

// CLI credentials stay under Claude Code's ownership. No SDK, token extraction,
// copied auth files, API fallback, or shell interpolation is involved.
export async function claudeChat(file: string, directory: string, request: ChatRequest, signal: AbortSignal, emit: (event: ChatEvent) => void, tools: AgentTools, timeoutMs = 180000) {
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
    await fs.writeFile(instructions, agentInstructions(request.mode ?? "discuss"), { mode: 0o600 });
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(file, claudeArguments(request.model, config, instructions, tools), { cwd: temp, detached: process.platform !== "win32", windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
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
      const delta = (value: string) => { textSize += value.length; if (textSize > 512000) stop("Claude Code output limit reached."); else emit({ id: request.id, delta: value }); };
      const line = (text: string) => {
        if (!text.trim() || failure) return;
        let event: any;
        try { event = JSON.parse(text); } catch { stop("Claude Code returned an invalid stream. Update it and retry."); return; }
        if (event.parent_tool_use_id) return;
        if (event.type === "system" && event.subtype === "init" && Array.isArray(event.tools)) {
          const allowed = new Set(["EndConversation", ...tools.definitions.map(tool => `mcp__workspace__${tool.function.name}`)]);
          if (event.tools.some((tool: unknown) => typeof tool !== "string" || !allowed.has(tool))) { stop("Claude Code loaded tools outside this mode. The turn was stopped; check managed CLI settings."); return; }
        }
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
      child.stdin.end(`Continue this conversation and answer the user's latest request. The JSON contains conversation history and shared reference context:\n${JSON.stringify(chatHistory(request.messages, request.context))}`);
    });
  } finally { turnController.abort(); await bridge.close(); if (temp) await fs.rm(temp, { recursive: true, force: true }); }
}
