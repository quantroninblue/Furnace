import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

// Append-only record of what the agent did in each project: every finished tool step
// (with how it was allowed), approval decisions, reverts and rewinds. One JSON line per
// entry; the file rotates once at 5 MB so the log stays bounded.
export type AuditEntry = {
  time: string; session: string; project: string | null; event: "tool" | "approval" | "revert" | "rewind" | "process" | "rule";
  tool?: string; title: string; status?: string; decision?: string; permission?: string; detail?: string;
};
const LIMIT = 5 * 1024 * 1024;

export class AuditLog {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private directory: string) {}
  file(root: string | null) { return path.join(this.directory, `${createHash("sha256").update(root ?? "(no project)").digest("hex").slice(0, 32)}.jsonl`); }
  append(entry: Omit<AuditEntry, "time">) {
    const line = JSON.stringify({ time: new Date().toISOString(), ...entry, title: entry.title.slice(0, 500), detail: entry.detail?.slice(0, 1000) }) + "\n";
    const file = this.file(entry.project);
    const next = this.queue.then(async () => {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const size = await fs.stat(file).then(info => info.size, () => 0);
      if (size > LIMIT) await fs.rename(file, file.replace(/\.jsonl$/, ".1.jsonl"));
      await fs.appendFile(file, line, { mode: 0o600 });
    });
    this.queue = next.catch(() => {});
    return next;
  }
  /** Newest entries first. */
  async read(root: string | null, limit = 300): Promise<AuditEntry[]> {
    await this.queue;
    let text = "";
    try {
      const handle = await fs.open(this.file(root));
      try {
        const { size } = await handle.stat(), length = Math.min(size, 1024 * 1024), buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, size - length); text = buffer.toString("utf8");
        if (length < size) text = text.slice(text.indexOf("\n") + 1);
      } finally { await handle.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const entries: AuditEntry[] = [];
    for (const line of text.split("\n").reverse()) {
      if (entries.length >= limit) break;
      try { if (line) entries.push(JSON.parse(line)); } catch { /* Skip a damaged line. */ }
    }
    return entries;
  }
  async clear(root: string | null) {
    await this.queue;
    for (const file of [this.file(root), this.file(root).replace(/\.jsonl$/, ".1.jsonl")]) await fs.rm(file, { force: true });
  }
}
