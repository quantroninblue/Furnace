import { randomUUID } from "node:crypto";
import { spawnAgentShell, type CommandTerminals, type SandboxSpec, type TerminalMirror } from "./commands";

// Long-running agent commands (dev servers, watchers). They outlive the turn that started
// them, show in their own IDE terminal and stop on request, on terminal close or when the
// IDE window closes. Output keeps the newest 200 KB.
export type ProcessInfo = { id: string; command: string; cwd: string; status: "running" | "exited"; exitCode: number | null; startedAt: number; endedAt?: number; sandboxed: boolean };
type Entry = ProcessInfo & { output: string; total: number; read: number; stop(): void; terminal: TerminalMirror | null; exited: Promise<void> };
const KEEP = 200_000, MAX_RUNNING = 5;

export class BackgroundProcesses {
  private entries = new Map<string, Entry>();
  constructor(private terminals: CommandTerminals | null, private changed: () => void = () => {}, private log: (info: ProcessInfo, event: "started" | "stopped" | "exited") => void = () => {}) {}
  list(): ProcessInfo[] { return [...this.entries.values()].map(({ id, command, cwd, status, exitCode, startedAt, endedAt, sandboxed }) => ({ id, command, cwd, status, exitCode, startedAt, endedAt, sandboxed })); }
  running() { return [...this.entries.values()].filter(entry => entry.status === "running").length; }
  /** Starts the command and waits briefly so early output (a port, a crash) reaches the model. */
  async start(command: string, options: { cwd: string; sandbox?: SandboxSpec; settleMs?: number }) {
    if (this.running() >= MAX_RUNNING) throw new Error(`${MAX_RUNNING} background processes are already running. Stop one with process_stop first.`);
    // Forget old exited processes so the list stays short.
    for (const entry of [...this.entries.values()].filter(item => item.status === "exited").slice(0, -10)) this.entries.delete(entry.id);
    const { child, stop, kill } = spawnAgentShell(command, options);
    const terminal = this.terminals?.open(command, options.cwd, true) ?? null;
    let resolveExit!: () => void;
    const entry: Entry = { id: randomUUID().slice(0, 8), command, cwd: options.cwd, status: "running", exitCode: null, startedAt: Date.now(), sandboxed: !!options.sandbox,
      output: "", total: 0, read: 0, stop, terminal, exited: new Promise(resolve => { resolveExit = resolve; }) };
    this.entries.set(entry.id, entry);
    terminal?.onInterrupt(() => this.stop(entry.id));
    const collect = (chunk: string) => { entry.total += chunk.length; entry.output = (entry.output + chunk).slice(-KEEP); terminal?.write(chunk); };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    const finish = (code: number | null) => {
      if (entry.status === "exited") return;
      entry.status = "exited"; entry.exitCode = code; entry.endedAt = Date.now();
      terminal?.exit(code); this.log(entry, "exited"); resolveExit(); this.changed();
    };
    child.once("error", error => { collect(`${error.message}\n`); finish(null); });
    child.once("close", code => finish(code));
    // A detached group survives our parent; make sure the IDE closing ends it.
    entry.stop = () => { stop(); setTimeout(() => kill("SIGKILL"), 3000).unref(); };
    this.log(entry, "started"); this.changed();
    await Promise.race([entry.exited, new Promise(resolve => setTimeout(resolve, options.settleMs ?? 3000))]);
    entry.read = entry.total;
    return { id: entry.id, status: entry.status, exitCode: entry.exitCode, output: entry.output.slice(-20000) };
  }
  /** New output since the last read (or the tail), plus the current status. */
  output(id: string) {
    const entry = this.get(id);
    const unread = Math.min(entry.total - entry.read, entry.output.length);
    entry.read = entry.total;
    return { id, command: entry.command, status: entry.status, exitCode: entry.exitCode, output: unread > 0 ? entry.output.slice(-unread).slice(-20000) : "(no new output since the last check)" };
  }
  async stop(id: string) {
    const entry = this.get(id);
    if (entry.status === "running") { entry.stop(); this.log(entry, "stopped"); await Promise.race([entry.exited, new Promise(resolve => setTimeout(resolve, 5000))]); }
    return { id, status: entry.status, exitCode: entry.exitCode };
  }
  show(id: string) { this.get(id).terminal?.show?.(); }
  async stopAll() { await Promise.all([...this.entries.values()].filter(entry => entry.status === "running").map(entry => this.stop(entry.id))); }
  private get(id: string) {
    const entry = this.entries.get(String(id));
    if (!entry) throw new Error(`No background process ${id}. Use process_list to see them.`);
    return entry;
  }
}
