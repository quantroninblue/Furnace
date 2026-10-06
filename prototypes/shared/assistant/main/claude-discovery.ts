import { execFile } from "node:child_process";
import { promises as fs, constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ClaudeStatus } from "../shared/types";

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

