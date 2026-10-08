import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { claudeArguments, claudeChat, claudeStatus } from "../main/claude-code";
import { workspaceMcp } from "../main/workspace-mcp";
import { createAgentTools } from "../main/agent-tools";
import { testContext } from "./tool-context";
import type { ChatEvent } from "../shared/types";

async function directory(t: TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-gui-claude-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir;
}
const request = { id: "turn", model: "sonnet", mode: "plan" as const, context: "Shared notes", messages: [{ id: "u", role: "user" as const, content: "Read the brief" }] };
const tools = () => createAgentTools("plan", null, testContext(), { plan: "A collaborative brief" });

test("Claude Code arguments restrict built-ins, hooks, MCP and persistence without bypassing permissions", () => {
  const args = claudeArguments("sonnet", "/private/config.json", "/private/instructions", tools());
  assert.ok(args.includes("--restricted"));
  assert.equal(args[args.indexOf("--tools") + 1], "");
  assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk");
  assert.equal(args[args.indexOf("--max-turns") + 1], "100");
  assert.equal(args[args.indexOf("--setting-sources") + 1], "");
  assert.ok(args.includes("--strict-mcp-config") && args.includes("--no-session-persistence"));
  assert.ok(!args.some(arg => /bypassPermissions|dangerously|--bare/.test(arg)));
  assert.ok(args[args.indexOf("--allowedTools") + 1].includes("mcp__furnace__plan_read"));
  assert.throws(() => claudeArguments("--arbitrary-flag", "", "", tools()));
});

test("workspace MCP authenticates, enforces mode and tool budget, and closes after abort", async () => {
  const abort = new AbortController(); let executed = 0;
  const bridge = await workspaceMcp({ definitions: tools().definitions, execute: async () => { executed++; return "fixture"; } }, abort.signal, () => {});
  try {
    const { url, headers } = bridge.config.mcpServers.furnace;
    const call = async (name: string, extra: Record<string, string> = {}, auth = headers) => fetch(url, { method: "POST", headers: { ...auth, "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...extra }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } }) });
    assert.equal((await call("plan_read", {}, { Authorization: "Bearer wrong" })).status, 403);
    assert.equal((await call("plan_read", { Origin: "https://untrusted.example" })).status, 403);
    const denied = await (await call("Bash")).json(); assert.equal(denied.result.isError, true); assert.equal(executed, 0);
    for (let index = 0; index < 250; index++) assert.equal((await (await call("plan_read")).json()).result.content[0].text, "fixture");
    assert.equal((await (await call("plan_read")).json()).result.isError, true); assert.equal(executed, 250);
    abort.abort();
    await assert.rejects(call("plan_read"));
  } finally { bridge.close(); }
});

test("Claude Code streams through the real process boundary and reads only scoped MCP tools", { skip: process.platform === "win32" }, async t => {
  const dir = await directory(t), file = path.join(dir, "claude");
  await fs.writeFile(file, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('2.1.285 (Claude Code)'); process.exit(0); }
if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true, email: 'fixture@example.com', authMethod: 'claude.ai', accessToken: 'MUST_NOT_LEAK' })); process.exit(0); }
let input = '';
process.stdin.on('data', part => input += part);
process.stdin.on('end', async () => {
  const model = args[args.indexOf('--model') + 1];
  const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
  if (model === 'haiku') { setInterval(() => {}, 1000); return; }
  if (!args.includes('--model')) { emit({ type:'system', subtype:'init', tools:[], mcp_servers:[] }); setInterval(() => {}, 1000); return; }
  if (model === 'opus') { emit({ type:'system', subtype:'init', tools:['Bash'] }); setInterval(() => {}, 1000); return; }
  if (model === 'fable') { emit({ type:'result', subtype:'error_during_execution', is_error:true, errors:['SECRET_DIAGNOSTIC'] }); return; }
  if (!input.includes('Read the brief') || !input.includes('Shared notes')) process.exit(2);
  const config = JSON.parse(fs.readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8')).mcpServers.furnace;
  const headers = { ...config.headers, 'Content-Type':'application/json', Accept:'application/json, text/event-stream' };
  const rpc = async (method, params) => (await fetch(config.url, { method:'POST', headers, body:JSON.stringify({ jsonrpc:'2.0', id:1, method, params }) })).json();
  await rpc('initialize', { protocolVersion:'2025-03-26', capabilities:{}, clientInfo:{name:'fixture', version:'1'} });
  const list = await rpc('tools/list', {});
  emit({ type:'system', subtype:'init', tools:list.result.tools.map(tool => 'mcp__furnace__' + tool.name), mcp_servers:[{ name:'furnace', status:'connected' }] });
  const result = await rpc('tools/call', { name:'plan_read', arguments:{} });
  const block = text => { emit({ type:'stream_event', event:{type:'content_block_start', index:0, content_block:{type:'text', text:''}} }); emit({ type:'stream_event', event:{type:'content_block_delta', index:0, delta:{type:'text_delta', text}} }); };
  block(result.result.content[0].text); block('Done.');
  emit({ type:'result', subtype:'success', is_error:false, result:'A collaborative brief' });
});
`, { mode: 0o700 });
  const status = await claudeStatus(file, dir);
  assert.equal(status.connected, true); assert.equal(status.version, "2.1.285");
  assert.equal(JSON.stringify(status).includes("MUST_NOT_LEAK"), false);
  const events: ChatEvent[] = [];
  await claudeChat(file, dir, request, new AbortController().signal, event => events.push(event), tools());
  assert.equal(events.map(event => event.delta ?? "").join(""), "A collaborative brief\n\nDone.");
  assert.ok(events.some(event => event.activity === "plan_read"));
  assert.deepEqual(await fs.readdir(dir), ["claude"]);
  for (const [model, error] of [["opus", /outside this mode/], ["fable", /could not complete/], ["default", /did not load/]] as const) {
    await assert.rejects(claudeChat(file, dir, { ...request, model }, new AbortController().signal, () => {}, tools()), error);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  try { await assert.rejects(claudeChat(file, dir, { ...request, model: "haiku" }, controller.signal, () => {}, tools()), /stopped/); }
  finally { clearTimeout(timer); }
  await assert.rejects(claudeChat(file, dir, { ...request, model: "haiku" }, new AbortController().signal, () => {}, tools(), 100), /timed out/);
  assert.deepEqual(await fs.readdir(dir), ["claude"]);
});

test("Claude Code discovery handles absent and old installations without inference", { skip: process.platform === "win32" }, async t => {
  const dir = await directory(t), file = path.join(dir, "claude");
  assert.equal((await claudeStatus(null, dir)).installed, false);
  await fs.writeFile(file, '#!/bin/sh\nprintf "2.1.100 (Claude Code)\\n"\n', { mode: 0o700 });
  const status = await claudeStatus(file, dir);
  assert.equal(status.compatible, false); assert.equal(status.connected, false);
  assert.match(status.error!, /Update Claude Code/);
});
