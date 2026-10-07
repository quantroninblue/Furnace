import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import os from "node:os";
import { createAgentTools, toolNames, type ToolHost, type Permission, type Step } from "../main/agent-tools";
import { testContext } from "./tool-context";

// Plain filesystem host standing in for the IDE adapter.
const nodeHost = (root: string | null, sandbox: string | null = null, trusted = true): ToolHost => ({
  root, trusted, sandbox,
  read: async file => (await fs.readFile(file)).toString("utf8"),
  kind: async file => { try { const info = await fs.stat(file); return info.isDirectory() ? "directory" : "file"; } catch { return null; } },
  list: async dir => (await fs.readdir(dir, { withFileTypes: true })).map(entry => ({ name: entry.name, directory: entry.isDirectory() })),
  write: async (file, text) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); return ""; },
  remove: async (file, recursive) => fs.rm(file, { recursive }),
  move: async (from, to) => { await fs.mkdir(path.dirname(to), { recursive: true }); await fs.rename(from, to); },
  mkdir: async dir => { await fs.mkdir(dir, { recursive: true }); },
});
async function project(run: (root: string, outside: string) => Promise<void>) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ai-gui-tools-")));
  const root = path.join(base, "project"), outside = path.join(base, "outside");
  await fs.mkdir(path.join(root, "src"), { recursive: true }); await fs.mkdir(outside);
  await fs.writeFile(path.join(root, "src/app.ts"), "export const value = 1;\nexport const name = 'app';\n");
  await fs.writeFile(path.join(root, ".env"), "TOKEN=secret\n");
  await fs.writeFile(path.join(outside, "private.txt"), "outside\n");
  try { await run(root, outside); } finally { await fs.rm(base, { recursive: true, force: true }); }
}
const build = (root: string | null, permission: Permission, decide: (step: Step) => boolean = () => true, sandbox: string | null = null) => {
  const context = testContext(permission, decide);
  return { context, tools: createAgentTools("build", nodeHost(root, sandbox), context) };
};

test("modes expose the right tools; hallucinated tools and untrusted projects are refused", async () => {
  assert.deepEqual(createAgentTools("discuss", null, testContext()).definitions, []);
  const plan = createAgentTools("plan", nodeHost("/tmp"), testContext(), { propose: () => {} }).definitions.map(tool => tool.function.name);
  assert.ok(plan.includes("read_file") && plan.includes("plan_propose") && !plan.includes("edit_file") && !plan.includes("run_command"));
  const full = createAgentTools("build", nodeHost("/tmp"), testContext()).definitions.map(tool => tool.function.name);
  for (const name of ["read_file", "glob", "grep", "write_file", "edit_file", "apply_patch", "delete_path", "move_path", "create_directory", "run_command", "web_fetch", "todo_write"]) assert.ok(full.includes(name), name);
  // Code intelligence needs the IDE's language servers, background-process tools a process host,
  // and verify_step the planning brief.
  const code = ["find_definition", "find_references", "find_symbols", "file_outline", "get_problems", "rename_symbol"];
  assert.deepEqual(toolNames("build").filter(name => !full.includes(name)).sort(), [...code, "verify_step", "process_output", "process_stop", "process_list"].sort());
  const verify = { brief: () => "", record: () => {}, confirm: () => {} };
  const withAll = createAgentTools("build", { ...nodeHost("/tmp"), code: {} as any }, { ...testContext(), processes: {} as any }, { verify }).definitions.map(tool => tool.function.name);
  assert.deepEqual(toolNames("build").filter(name => !withAll.includes(name)), []);
  const planCode = createAgentTools("plan", { ...nodeHost("/tmp"), code: {} as any }, testContext(), { propose: () => {} }).definitions.map(tool => tool.function.name);
  assert.ok(planCode.includes("find_references") && !planCode.includes("rename_symbol") && !planCode.includes("verify_step"));
  await assert.rejects(createAgentTools("plan", nodeHost("/tmp"), testContext()).execute("edit_file", {}), /not available in plan mode/);
  const untrusted = createAgentTools("build", nodeHost("/tmp", null, false), testContext());
  assert.ok(!untrusted.definitions.some(tool => tool.function.name === "read_file"));
  await assert.rejects(untrusted.execute("read_file", { path: "x", offset: null, limit: null }), /opens and trusts a project/);
  for (const tool of createAgentTools("build", nodeHost("/tmp"), testContext()).definitions) {
    const { properties, required } = tool.function.parameters;
    assert.deepEqual([...required].sort(), Object.keys(properties).sort(), `${tool.function.name} is strict-schema compatible`);
  }
});

test("Auto edits inside the project directly; secrets and outside paths need approval", () => project(async (root, outside) => {
  const { tools, context } = build(root, "auto", step => step.approval !== "outside" || step.title.includes(".env"));
  assert.match(await tools.execute("read_file", { path: "src/app.ts", offset: null, limit: null }), /1\texport const value = 1;/);
  assert.match(await tools.execute("edit_file", { path: "src/app.ts", old_string: "value = 1", new_string: "value = 2", replace_all: null }), /Edited src\/app.ts \(\+1 −1/);
  assert.equal(await fs.readFile(path.join(root, "src/app.ts"), "utf8"), "export const value = 2;\nexport const name = 'app';\n");
  assert.equal(context.approvals.length, 0);
  await assert.rejects(tools.execute("edit_file", { path: "src/app.ts", old_string: "export const", new_string: "const", replace_all: null }), /matches 2 places/);
  await assert.rejects(tools.execute("edit_file", { path: "src/app.ts", old_string: "missing", new_string: "x", replace_all: null }), /not found/);
  await tools.execute("write_file", { path: "README.md", content: "x\n" });
  assert.match(await tools.execute("write_file", { path: "README.md", content: "y\n" }), /Wrote README.md/); // Files the agent wrote count as read.
  await fs.writeFile(path.join(root, "notes.txt"), "existing\n");
  await assert.rejects(tools.execute("write_file", { path: "notes.txt", content: "clobber" }), /Read it with read_file first/);
  assert.match(await tools.execute("write_file", { path: "deep/new/dir/file.txt", content: "hello\n" }), /Created deep\/new\/dir\/file.txt/);
  assert.equal(await fs.readFile(path.join(root, "deep/new/dir/file.txt"), "utf8"), "hello\n");
  // Secret file and outside paths ask first; denial leaves files untouched.
  await tools.execute("read_file", { path: ".env", offset: null, limit: null });
  assert.equal(context.approvals.at(-1)?.approval, "outside");
  await assert.rejects(tools.execute("write_file", { path: path.join(outside, "agent.txt"), content: "pwned" }), /denied/);
  await assert.rejects(fs.stat(path.join(outside, "agent.txt")));
  assert.equal(await fs.readFile(path.join(outside, "private.txt"), "utf8"), "outside\n");
  assert.equal(context.steps.at(-1)?.status, "denied");
  await assert.rejects(tools.execute("read_file", { path: "../outside/private.txt", offset: null, limit: null }), /denied/);
  await fs.symlink(outside, path.join(root, "link"));
  const before = context.approvals.length;
  await assert.rejects(tools.execute("read_file", { path: "link/private.txt", offset: null, limit: null }), /denied/);
  assert.equal(context.approvals.length, before + 1);
  assert.equal(context.approvals.at(-1)?.approval, "outside");
  assert.equal(await fs.readFile(path.join(outside, "private.txt"), "utf8"), "outside\n");
}));

test("Ask mode gates every change; Full access never asks, even outside the project", () => project(async (root, outside) => {
  const ask = build(root, "ask", () => false);
  await assert.rejects(ask.tools.execute("create_directory", { path: "made" }), /denied/);
  await assert.rejects(fs.stat(path.join(root, "made")));
  assert.equal(ask.context.approvals[0].approval, "edit");
  assert.match(await ask.tools.execute("grep", { pattern: "value", path: null, glob: null, ignore_case: null }), /src\/app.ts:1:/);
  const full = build(null, "full", () => { throw new Error("must not ask"); });
  await full.tools.execute("write_file", { path: path.join(outside, "made-by-agent.txt"), content: "ok\n" });
  assert.equal(await fs.readFile(path.join(outside, "made-by-agent.txt"), "utf8"), "ok\n");
  await assert.rejects(full.tools.execute("read_file", { path: "relative.txt", offset: null, limit: null }), /No project folder is open/);
}));

test("apply_patch adds, updates, moves and deletes files after one approval", () => project(async (root) => {
  const { tools, context } = build(root, "ask");
  await fs.writeFile(path.join(root, "old.txt"), "remove me\n");
  const result = await tools.execute("apply_patch", { patch: [
    "*** Begin Patch", "*** Add File: docs/new.md", "+# New", "+text",
    "*** Update File: src/app.ts", "*** Move to: src/main.ts", "@@", " export const value = 1;", "-export const name = 'app';", "+export const name = 'main';",
    "*** Delete File: old.txt", "*** End Patch"].join("\n") });
  assert.match(result, /added docs\/new.md, moved src\/main.ts, deleted old.txt/);
  assert.equal(context.approvals.length, 1);
  assert.match(context.approvals[0].diff!, /\+export const name = 'main';/);
  assert.equal(await fs.readFile(path.join(root, "docs/new.md"), "utf8"), "# New\ntext\n");
  assert.equal(await fs.readFile(path.join(root, "src/main.ts"), "utf8"), "export const value = 1;\nexport const name = 'main';\n");
  await assert.rejects(fs.stat(path.join(root, "src/app.ts"))); await assert.rejects(fs.stat(path.join(root, "old.txt")));
  await assert.rejects(tools.execute("apply_patch", { patch: "*** Begin Patch\n*** Update File: src/main.ts\n@@\n-nope\n+x\n*** End Patch" }), /did not match/);
  assert.match(await tools.execute("glob", { pattern: "**/*.md", path: null }), /docs\/new.md/);
  await tools.execute("move_path", { source: "docs", destination: "documentation" });
  await assert.rejects(tools.execute("delete_path", { path: "documentation", recursive: null }), /not empty/);
  await tools.execute("delete_path", { path: "documentation", recursive: true });
  await assert.rejects(fs.stat(path.join(root, "documentation")));
  await assert.rejects(tools.execute("delete_path", { path: ".", recursive: true }), /project root/);
}));

const sandboxHelper = (async () => {
  if (process.platform !== "linux") return null;
  const output = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "ai-gui-sbx-")), "ai-gui-sandbox");
  try {
    execFileSync("cc", ["-O2", "-o", output, path.join(__dirname, "../../../code-oss/product/sandbox/ai-gui-sandbox.c")], { stdio: "pipe" });
    return execFileSync(output, ["--probe"]).toString().startsWith("ok") ? output : null;
  } catch { return null; }
})();

test("commands: Auto runs sandboxed without asking; Ask and unsandboxed Auto require approval", () => project(async (root, outside) => {
  const helper = await sandboxHelper;
  // /tmp is writable inside the sandbox by design, so probe escapes from a non-temp folder.
  const cache = path.join(__dirname, "../../../code-oss/.cache"); await fs.mkdir(cache, { recursive: true });
  const blocked = await fs.mkdtemp(path.join(cache, "tool-test-outside-"));
  try {
  const auto = build(root, "auto", () => true, helper);
  const result = await auto.tools.execute("run_command", { command: `echo inside > made.txt; echo escaped > ${blocked}/escape.txt; echo done`, workdir: null, timeout_seconds: null, escalate: null, justification: null });
  if (helper) {
    assert.equal(auto.context.approvals.length, 0);
    assert.match(result, /Sandboxed/); assert.match(result, /Permission denied/);
    assert.equal(await fs.readFile(path.join(root, "made.txt"), "utf8"), "inside\n");
    await assert.rejects(fs.stat(path.join(blocked, "escape.txt")));
    await auto.tools.execute("run_command", { command: "true", workdir: null, timeout_seconds: null, escalate: true, justification: "needs network" });
    assert.equal(auto.context.approvals.at(-1)?.approval, "command");
  } else assert.equal(auto.context.approvals[0].approval, "command");
  } finally { await fs.rm(blocked, { recursive: true, force: true }); }
  const ask = build(root, "ask", () => false);
  await assert.rejects(ask.tools.execute("run_command", { command: "touch never.txt", workdir: null, timeout_seconds: null, escalate: null, justification: null }), /denied/);
  await assert.rejects(fs.stat(path.join(root, "never.txt")));
  const full = build(root, "full");
  assert.match(await full.tools.execute("run_command", { command: "printf 'out'; exit 3", workdir: "src", timeout_seconds: null, escalate: null, justification: null }), /^Exit code: 3\nout/);
  assert.match(await full.tools.execute("run_command", { command: "sleep 5", workdir: null, timeout_seconds: 1, escalate: null, justification: null }), /timed out/);
  assert.equal(full.context.steps.at(-1)?.status, "failed");
}));

test("web_fetch asks first outside Full access and returns readable text", async () => {
  const server = createServer((_, res) => { res.setHeader("content-type", "text/html"); res.end("<html><head><script>bad()</script></head><body><h1>Docs</h1><p>Use &amp; enjoy.</p></body></html>"); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    const denied = build("/tmp", "auto", () => false);
    await assert.rejects(denied.tools.execute("web_fetch", { url }), /denied/);
    assert.equal(denied.context.approvals[0].approval, "network");
    const text = await build("/tmp", "full").tools.execute("web_fetch", { url });
    assert.match(text, /Docs\nUse & enjoy\./); assert.ok(!text.includes("bad()"));
    await assert.rejects(build("/tmp", "full").tools.execute("web_fetch", { url: "file:///etc/passwd" }), /HTTP/);
  } finally { server.close(); }
});

test("todo_write, plan and research proposals remain review artifacts", async () => {
  const context = testContext();
  const proposals: unknown[] = [];
  const plan = createAgentTools("plan", null, context, { plan: "Original brief", propose: proposal => proposals.push(proposal) });
  assert.equal(await plan.execute("plan_read", {}), "Original brief");
  await plan.execute("plan_propose", { text: "New brief", reason: "Clearer" });
  await plan.execute("todo_write", { todos: [{ content: "Explore", status: "completed" }, { content: "Edit", status: "in_progress" }] });
  assert.equal(context.steps.at(-1)?.title, "Tasks 1/2 done");
  const research = createAgentTools("research", null, testContext(), { sources: [], selection: { url: "https://example.com", title: "Example", text: "Selected source" }, propose: proposal => proposals.push(proposal) });
  assert.match(await research.execute("research_selection", {}), /Selected source/);
  await research.execute("research_browse_propose", { url: "https://example.com/docs", reason: "Reference" });
  await assert.rejects(research.execute("research_browse_propose", { url: "file:///etc/passwd", reason: "" }), /HTTP/);
  assert.deepEqual(proposals.map(item => (item as { kind: string }).kind), ["plan", "browse"]);
});
