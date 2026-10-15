import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ToolHost } from "../main/agent-tools";
import { createAgentTools } from "../main/agent-tools";
import { TurnChanges, recordingHost, restoreChanges, mergeCheckpoints, Checkpoints } from "../main/checkpoints";
import { slash } from "../main/search";
import { testContext } from "./tool-context";

const nodeHost = (root: string): ToolHost => ({
  root, trusted: true, sandbox: null,
  read: async file => (await fs.readFile(file)).toString("utf8"),
  kind: async file => { try { const info = await fs.stat(file); return info.isDirectory() ? "directory" : "file"; } catch { return null; } },
  list: async dir => (await fs.readdir(dir, { withFileTypes: true })).map(entry => ({ name: entry.name, directory: entry.isDirectory() })),
  write: async (file, text) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); return ""; },
  remove: async (file, recursive) => fs.rm(file, { recursive }),
  move: async (from, to) => { await fs.mkdir(path.dirname(to), { recursive: true }); await fs.rename(from, to); },
  mkdir: async dir => { await fs.mkdir(dir, { recursive: true }); },
});
async function project(run: (root: string) => Promise<void>) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ai-gui-checkpoints-")));
  await fs.mkdir(path.join(root, "src/lib"), { recursive: true });
  await fs.writeFile(path.join(root, "src/app.ts"), "one\ntwo\n");
  await fs.writeFile(path.join(root, "src/lib/a.ts"), "a\n");
  await fs.writeFile(path.join(root, "src/lib/b.ts"), "b\n");
  try { await run(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}
const read = (root: string, file: string) => fs.readFile(path.join(root, file), "utf8");
const exists = (root: string, file: string) => fs.stat(path.join(root, file)).then(() => true, () => false);
const turn = (root: string) => {
  const changes = new TurnChanges(file => slash(path.relative(root, file)));
  return { changes, tools: createAgentTools("build", recordingHost(nodeHost(root), changes), testContext("auto")) };
};

test("a turn's edits, creations, deletions and moves are recorded and fully restored", () => project(async root => {
  const { changes, tools } = turn(root);
  await tools.execute("read_file", { path: "src/app.ts", offset: null, limit: null });
  await tools.execute("edit_file", { path: "src/app.ts", old_string: "two", new_string: "TWO", replace_all: null });
  await tools.execute("edit_file", { path: "src/app.ts", old_string: "one", new_string: "ONE", replace_all: null });
  await tools.execute("write_file", { path: "new/deep/file.txt", content: "created\n" });
  await tools.execute("delete_path", { path: "src/lib/a.ts", recursive: null });
  await tools.execute("move_path", { source: "src/lib", destination: "moved/lib" });
  await tools.execute("create_directory", { path: "empty/dir" });
  assert.deepEqual(changes.summary().map(item => `${item.status} ${item.path} +${item.added} −${item.removed}`).sort(), [
    "added moved/lib/b.ts +1 −0", "added new/deep/file.txt +1 −0", "deleted src/lib/a.ts +0 −1", "deleted src/lib/b.ts +0 −1", "modified src/app.ts +2 −2",
  ]);
  const result = await restoreChanges(nodeHost(root), changes.checkpoint());
  assert.deepEqual(result.conflicts, []);
  assert.equal(await read(root, "src/app.ts"), "one\ntwo\n");
  assert.equal(await read(root, "src/lib/a.ts"), "a\n");
  assert.equal(await read(root, "src/lib/b.ts"), "b\n");
  for (const gone of ["new", "moved", "empty"]) assert.equal(await exists(root, gone), false, gone);
}));

test("restoring refuses files changed since the agent's edit unless forced", () => project(async root => {
  const { changes, tools } = turn(root);
  await tools.execute("write_file", { path: "notes.txt", content: "agent\n" });
  await tools.execute("read_file", { path: "src/app.ts", offset: null, limit: null });
  await tools.execute("edit_file", { path: "src/app.ts", old_string: "two", new_string: "TWO", replace_all: null });
  await fs.writeFile(path.join(root, "src/app.ts"), "user edited\n");
  const checkpoint = changes.checkpoint();
  const refused = await restoreChanges(nodeHost(root), checkpoint);
  assert.deepEqual(refused.conflicts, ["src/app.ts"]);
  assert.equal(await read(root, "notes.txt"), "agent\n", "nothing changes while a conflict is unresolved");
  const forced = await restoreChanges(nodeHost(root), checkpoint, true);
  assert.deepEqual(forced.restored.sort(), ["notes.txt", "src/app.ts"]);
  assert.equal(await read(root, "src/app.ts"), "one\ntwo\n");
  assert.equal(await exists(root, "notes.txt"), false);
}));

test("several turns merge into one rewind and stored checkpoints survive a reload", () => project(async root => {
  const first = turn(root), second = turn(root);
  await first.tools.execute("read_file", { path: "src/app.ts", offset: null, limit: null });
  await first.tools.execute("edit_file", { path: "src/app.ts", old_string: "one", new_string: "1", replace_all: null });
  await second.tools.execute("read_file", { path: "src/app.ts", offset: null, limit: null });
  await second.tools.execute("edit_file", { path: "src/app.ts", old_string: "two", new_string: "2", replace_all: null });
  await second.tools.execute("write_file", { path: "added.txt", content: "x" });
  const store = new Checkpoints(path.join(root, ".store"), 2);
  await store.save("session-1", "turn-1", first.changes.checkpoint());
  await store.save("session-1", "turn-2", second.changes.checkpoint());
  const merged = mergeCheckpoints([await store.load("session-1", "turn-1"), await store.load("session-1", "turn-2")]);
  assert.equal(merged.files.find(item => item.path === "src/app.ts")!.before, "one\ntwo\n");
  assert.deepEqual((await restoreChanges(nodeHost(root), merged)).conflicts, []);
  assert.equal(await read(root, "src/app.ts"), "one\ntwo\n");
  assert.equal(await exists(root, "added.txt"), false);
  await store.save("session-1", "turn-3", { files: [], directories: [] });
  await new Promise(resolve => setTimeout(resolve, 20));
  await store.save("session-1", "turn-4", { files: [], directories: [] });
  await assert.rejects(store.load("session-1", "turn-1"), /no longer available/);
  await assert.rejects(store.load("../x", "turn-1"), /Invalid checkpoint/);
}));

test("a failing multi-file patch rolls back the files it already changed", () => project(async root => {
  const tools = createAgentTools("build", nodeHost(root), testContext("auto"));
  await tools.execute("read_file", { path: "src/app.ts", offset: null, limit: null });
  // The second file's write fails (its path is a directory), after the first succeeded.
  await fs.mkdir(path.join(root, "blocked"));
  const host = nodeHost(root);
  const failing: ToolHost = { ...host, write: async (file, text) => { if (file.endsWith(path.join("lib", "b.ts"))) throw new Error("disk full"); return host.write(file, text); } };
  const patched = createAgentTools("build", failing, testContext("auto"));
  await assert.rejects(patched.execute("apply_patch", { patch: [
    "*** Begin Patch", "*** Update File: src/app.ts", "-one", "+uno", " two", "*** Add File: extra.txt", "+extra", "*** Update File: src/lib/b.ts", "-b", "+B", "*** End Patch",
  ].join("\n") }), /Patch failed at src\/lib\/b.ts: disk full Files changed earlier in this patch were restored/);
  assert.equal(await read(root, "src/app.ts"), "one\ntwo\n");
  assert.equal(await exists(root, "extra.txt"), false);
  assert.equal(await read(root, "src/lib/b.ts"), "b\n");
  await assert.rejects(tools.execute("apply_patch", { patch: "*** Begin Patch\n*** Update File: src/lib/a.ts\n*** Move to: src/app.ts\n-a\n+A\n*** End Patch" }), /already exists/);
  assert.equal(await read(root, "src/lib/a.ts"), "a\n");
}));
