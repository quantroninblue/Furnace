// Opt-in integration check: uses the installed local model, never runs in npm test.
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { availableMemory, preflightModel } from "./model-preflight";
import { chat } from "../src/main/ollama";
import { createAgentTools } from "../src/main/agent-tools";
import { FileReviews } from "../src/main/file-reviews";
import { Workspace } from "../src/main/workspace";
import type { AgentMode, ChatEvent, Proposal } from "../src/shared/types";

async function main() {
  const model = process.argv[2];
  await preflightModel(model, await availableMemory());
  const modes = (process.argv[3] || "discuss,plan,build,research").split(",") as AgentMode[];
  if (modes.some(mode => !["discuss", "plan", "build", "research"].includes(mode)))
    throw new Error("Unknown check mode. Use discuss, plan, build or research.");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-gui-live-"));
  const workspace = new Workspace(await fs.realpath(root));
  await fs.writeFile(path.join(root, "hello.ts"), "export const greeting = 'Hello';\n");
  const prompts = {
    discuss: "In one short sentence, explain what a project brief is.",
    plan: "Read the current brief with plan_read. Then use plan_propose to propose a short updated brief with a goal and two next steps. Do not merely describe the proposal; call the tool. End with one sentence.",
    build: "Use project_read to read hello.ts, then call file_propose to change the greeting to 'Hello, collaborator'. Do not propose a shell command. End with one sentence explaining that the file change awaits review.",
    research: "Use research_sources to read the shared reference. Then use research_browse_propose to suggest its linked documentation URL. End with one sentence. Do not use research_selection.",
  };
  try {
    for (const mode of modes) {
      const events: ChatEvent[] = [], proposals: Proposal[] = [];
      const start = Date.now(); console.log(`Checking ${mode} with ${model}…`);
      await chat({ id: `live-${mode}`, model, mode, context: "", messages: [{ id: "request", role: "user", content: prompts[mode] }] }, AbortSignal.timeout(240000), event => { events.push(event); if (event.activity) console.log(`  tool: ${event.activity}`); }, createAgentTools(mode, mode === "build" ? workspace : null, "Build a small collaborative text editor.", null, proposal => proposals.push(proposal), {
        files: new FileReviews(), sources: [{ id: "example", title: "Example project documentation", url: "https://example.com/", text: "The project documentation is linked below.", links: [{ url: "https://example.com/docs", label: "Documentation" }], images: [], capturedAt: new Date().toISOString(), truncated: false }],
      }));
      const text = events.map(event => event.delta ?? "").join("");
      assert.ok(text.trim(), "Expected a visible reply");
      if (mode === "discuss") assert.equal(events.filter(event => event.activity).length, 0);
      if (mode === "plan") { assert.ok(events.some(event => event.activity === "plan_read")); assert.ok(proposals.some(proposal => proposal.kind === "plan")); }
      if (mode === "build") { assert.ok(proposals.some(proposal => proposal.kind === "file")); assert.equal((await workspace.read("hello.ts")).text, "export const greeting = 'Hello';\n"); }
      if (mode === "research") { assert.ok(events.some(event => event.activity === "research_sources")); assert.ok(proposals.some(proposal => proposal.kind === "browse" && proposal.text === "https://example.com/docs")); }
      console.log(`PASS ${mode} (${Math.round((Date.now() - start) / 1000)}s): ${text.slice(0, 220)}`);
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
