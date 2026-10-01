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
