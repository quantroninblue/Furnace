import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { findGitBash, runCommand } from "../main/commands";
import type { ChatEvent } from "../shared/types";

test("explicit command streams stdout and stderr, uses project cwd, and reports exit", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-gui-command-"));
  try {
    const script = path.join(root, "command.cjs");
    await fs.writeFile(script, 'console.log(process.cwd()); console.error("stderr captured"); process.exitCode = 7;');
    const events: ChatEvent[] = [];
    const job = runCommand("command-test", `"${process.execPath}" "${script}"`, root, event => events.push(event));
    await job.done;
    const output = events.map(event => event.delta ?? "").join("");
    assert.ok(output.includes(root));
    assert.ok(output.includes("stderr captured"));
    assert.equal(events.at(-1)?.exitCode, 7);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("running commands can be stopped", { timeout: 8000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-gui-stop-"));
  try {
    const script = path.join(root, "wait.cjs");
    await fs.writeFile(script, 'console.log("READY"); setInterval(() => {}, 1000);');
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const job = runCommand("stop-test", `"${process.execPath}" "${script}"`, root, event => { if (event.delta?.includes("READY")) ready(); });
    await started;
    job.stop();
    await job.done;
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("Windows agent commands use Git for Windows' bash, never WSL's", () => {
  const has = (...files: string[]) => (file: string) => files.includes(file);
  const env = { ProgramFiles: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local", PATH: "C:\\Windows\\System32;D:\\Tools\\Git\\cmd" };
  assert.equal(findGitBash(env, has("C:\\Program Files\\Git\\bin\\bash.exe")), "C:\\Program Files\\Git\\bin\\bash.exe");
  assert.equal(findGitBash(env, has("C:\\Users\\a\\AppData\\Local\\Programs\\Git\\bin\\bash.exe")), "C:\\Users\\a\\AppData\\Local\\Programs\\Git\\bin\\bash.exe", "per-user Git install");
  assert.equal(findGitBash(env, has("D:\\Tools\\Git\\cmd\\git.exe", "D:\\Tools\\Git\\bin\\bash.exe")), "D:\\Tools\\Git\\bin\\bash.exe", "Git found on PATH");
  assert.equal(findGitBash(env, has("C:\\Windows\\System32\\bash.exe")), null, "WSL's bash is not used");
  assert.equal(findGitBash({}, () => false), null);
});
