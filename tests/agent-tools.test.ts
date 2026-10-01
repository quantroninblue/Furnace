import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Workspace } from "../src/main/workspace";
import { createAgentTools } from "../src/main/agent-tools";
import type { Proposal } from "../src/shared/types";

test("mode tool restrictions are enforced, including hallucinated tool names", async () => {
  const discuss = createAgentTools("discuss", null, "", null, () => {});
  assert.deepEqual(discuss.definitions, []);
  await assert.rejects(discuss.execute("project_read", { path: "test.txt" }), /not permitted/);
  const research = createAgentTools("research", null, "", { url: "https://example.com", title: "Example", text: "Selected source" }, () => {});
  assert.match(await research.execute("research_selection", {}), /Selected source/);
  await assert.rejects(research.execute("command_propose", { text: "pwd", reason: "test" }), /not permitted/);
  await assert.rejects(research.execute("research_selection", { unexpected: "argument" }), /Invalid/);
});

test("file tools exclude secret files, escaping paths and secret aliases", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "ai-gui-tools-"));
  try {
    const root = path.join(base, "project");
    await fs.mkdir(root);
    await fs.writeFile(path.join(base, "outside.txt"), "private");
    await fs.writeFile(path.join(root, ".env"), "SECRET=value");
    await fs.writeFile(path.join(root, "main.ts"), "export const value = 1");
    await fs.symlink(path.join(root, ".env"), path.join(root, "alias.txt"));
    const tools = createAgentTools("build", new Workspace(await fs.realpath(root)), "", null, () => {});
    await assert.rejects(tools.execute("project_read", { path: "../outside.txt" }), /outside/);
    await assert.rejects(tools.execute("project_read", { path: ".env" }), /excluded/);
    await assert.rejects(tools.execute("project_read", { path: "alias.txt" }), /excluded/);
    assert.match(await tools.execute("project_read", { path: "main.ts" }), /export const/);
    assert.doesNotMatch(await tools.execute("project_list", { path: "" }), /\.env/);
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});

test("plan and command proposals are review artifacts, not executions", async () => {
  const proposals: Proposal[] = [];
  const tools = createAgentTools("plan", null, "Original brief", null, proposal => proposals.push(proposal));
  assert.match(await tools.execute("plan_propose", { text: "New brief", reason: "Simpler scope" }), /Pending review/);
  assert.equal(await tools.execute("plan_read", {}), "Original brief");
  assert.equal(proposals[0].text, "New brief");
  const build = createAgentTools("build", null, "", null, proposal => proposals.push(proposal));
  assert.match(await build.execute("command_propose", { text: "echo hello", reason: "A check" }), /nothing has been executed/);
  assert.equal(proposals[1].kind, "command");
});

test("research can read opted-in sources and suggest URLs without opening them", async () => {
  const proposals: Proposal[] = [];
  const tools = createAgentTools("research", null, "", null, proposal => proposals.push(proposal), {
    sources: [{ id: "source", url: "https://example.com", title: "Example", text: "Captured reference", links: [], images: [], capturedAt: new Date().toISOString(), truncated: false }],
  });
  assert.match(await tools.execute("research_sources", {}), /Captured reference/);
  await tools.execute("research_browse_propose", { url: "https://example.com/article", reason: "Relevant source" });
  assert.equal(proposals[0].kind, "browse");
  await assert.rejects(tools.execute("research_browse_propose", { url: "file:///etc/passwd", reason: "" }), /HTTP/);
  await assert.rejects(tools.execute("research_browse_propose", { url: "https://user:pass@example.com", reason: "" }), /HTTP/);
  const unshared = createAgentTools("research", null, "", null, () => {});
  assert.equal(await unshared.execute("research_sources", {}), "[]");
});
