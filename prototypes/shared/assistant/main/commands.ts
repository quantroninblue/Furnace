import { spawn } from "node:child_process";
import type { ChatEvent } from "../shared/types";

// Only explicit user commands enter here, never inferred model output.
export function runCommand(
  id: string,
  command: string,
  cwd: string,
  emit: (event: ChatEvent) => void,
) {
  const windows = process.platform === "win32";
  const shell = windows
    ? process.env.COMSPEC || "cmd.exe"
    : process.env.SHELL || "/bin/bash";
  const child = spawn(
    shell,
    windows ? ["/d", "/s", "/c", command] : ["-c", command],
    {
      cwd,
      detached: !windows,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, TERM: "dumb", NO_COLOR: "1" },
    },
  );
  let finished = false;
  let stopping = false;
  let outputSize = 0;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  const kill = (force: boolean) => {
    if (!child.pid) return;
    if (windows) {
      const killer = spawn(
        "taskkill",
        ["/pid", String(child.pid), "/T", "/F"],
        { windowsHide: true, stdio: "ignore" },
      );
      killer.on("error", () => {
        child.kill();
      });
    } else {
      try {
        process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
      } catch {
        /* The process group already exited. */
      }
    }
  };
  const stop = (reason = "Command stopped.") => {
    if (finished || stopping) return;
    stopping = true;
    emit({ id, delta: `\n${reason}\n` });
    kill(false);
    forceTimer = setTimeout(() => kill(true), 1000);
    forceTimer.unref();
  };
  const timeout = setTimeout(
    () =>
      stop(
        "Command stopped after the 2-minute limit. Use the shell panel for long-running or interactive work.",
      ),
    120000,
  );
  timeout.unref();
  const output = (text: string) => {
    if (stopping) return;
    const remaining = 512000 - outputSize;
    const chunk = text.slice(0, remaining);
    outputSize += chunk.length;
    if (chunk) emit({ id, delta: chunk });
    if (text.length > remaining)
      stop("Output limit reached (512 KB); command stopped.");
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", output);
  child.stderr.on("data", output);
  const done = new Promise<void>((resolve) => {
    child.once("error", (error) => emit({ id, delta: `${error.message}\n` }));
    child.once("close", (code) => {
      finished = true;
      clearTimeout(timeout);
      // After cancellation, let the forced group kill handle surviving children.
      if (!stopping && forceTimer) clearTimeout(forceTimer);
      emit({ id, done: true, exitCode: code });
      resolve();
    });
  });
  return { stop, done };
}

/** Mirrors an agent command in an IDE terminal; the user can interrupt it from there. */
export interface TerminalMirror { write(text: string): void; exit(code: number | null): void; onInterrupt(listener: () => void): void; show?(): void }
export interface CommandTerminals { open(command: string, cwd: string, background: boolean): TerminalMirror | null }
export type SandboxSpec = { helper: string; writable: string[] };

// Starts an agent command in its own process group, optionally inside the sandbox helper.
export function spawnAgentShell(command: string, options: { cwd: string; sandbox?: SandboxSpec }) {
  const windows = process.platform === "win32";
  const shell = windows ? process.env.COMSPEC || "cmd.exe" : "/bin/bash";
  const shellArgs = windows ? ["/d", "/s", "/c", command] : ["-c", command];
  const [file, args] = options.sandbox
    ? [options.sandbox.helper, [...options.sandbox.writable.flatMap((dir) => ["--write", dir]), "--", shell, ...shellArgs]]
    : [shell, shellArgs];
  const child = spawn(file, args, {
    cwd: options.cwd, detached: !windows, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, TERM: "dumb", NO_COLOR: "1", GIT_TERMINAL_PROMPT: "0", PAGER: "cat", GIT_PAGER: "cat", CI: process.env.CI ?? "1" },
  });
  const kill = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    if (windows) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => child.kill());
    else try { process.kill(-child.pid, signal); } catch { /* Already exited. */ }
  };
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  return { child, kill, stop: () => { kill("SIGTERM"); setTimeout(() => kill("SIGKILL"), 2000).unref(); } };
}

// Agent-requested commands. The tool layer decides approval and sandboxing first;
// this runner captures output for the model, enforces the timeout and kills the
// whole process group on stop. A terminal mirror shows it live in the IDE.
export function runAgentCommand(
  command: string,
  options: { cwd: string; timeoutMs: number; signal: AbortSignal; sandbox?: SandboxSpec; onOutput?: (text: string) => void; terminal?: TerminalMirror | null },
): Promise<{ exitCode: number | null; output: string; timedOut: boolean; interrupted: boolean }> {
  return new Promise((resolve, reject) => {
    if (options.signal.aborted) { reject(options.signal.reason ?? new Error("Stopped.")); return; }
    const { child, stop } = spawnAgentShell(command, options);
    let output = "", timedOut = false, interrupted = false, settled = false;
    const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs);
    const abort = () => stop();
    options.signal.addEventListener("abort", abort, { once: true });
    options.terminal?.onInterrupt(() => { interrupted = true; stop(); });
    const collect = (chunk: string) => {
      if (output.length < 4_000_000) output += chunk;
      options.onOutput?.(chunk); options.terminal?.write(chunk);
    };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    child.once("error", (error) => { if (!settled) { settled = true; clearTimeout(timer); options.signal.removeEventListener("abort", abort); options.terminal?.exit(null); reject(error); } });
    child.once("close", (code) => {
      if (settled) return; settled = true;
      clearTimeout(timer); options.signal.removeEventListener("abort", abort); options.terminal?.exit(code);
      if (options.signal.aborted) { reject(options.signal.reason ?? new Error("Stopped.")); return; }
      resolve({ exitCode: code, output, timedOut, interrupted });
    });
  });
}
