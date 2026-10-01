import { test } from "node:test";
import assert from "node:assert/strict";
import { remoteChat, remoteModels, chatgptModels } from "../src/main/remote-models";
import { createAgentTools } from "../src/main/agent-tools";
import type { ChatEvent } from "../src/shared/types";

const sse = (events: any[]) => new Response(events.map((event, index) => `event: ${event.type}\ndata: ${JSON.stringify({ sequence_number: index, ...event })}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
function openAIStream(output: any[], status = "completed") {
  const base = { id: "resp_test", object: "response", created_at: 1, model: "gpt-6-astra", status: "in_progress", output: [] };
  const events: any[] = [{ type: "response.created", response: base }];
  output.forEach((item, index) => {
    events.push({ type: "response.output_item.added", output_index: index, item: item.type === "message" ? { ...item, content: [] } : item });
    if (item.type === "message") {
      events.push({ type: "response.content_part.added", output_index: index, content_index: 0, item_id: item.id, part: { type: "output_text", text: "", annotations: [] } });
      events.push({ type: "response.output_text.delta", output_index: index, content_index: 0, item_id: item.id, delta: item.content[0].text });
    }
    events.push({ type: "response.output_item.done", output_index: index, item });
  });
  events.push({ type: status === "completed" ? "response.completed" : "response.incomplete", response: { ...base, status, output } });
  return sse(events);
}
const request = { id: "test", model: "gpt-6-astra", mode: "plan" as const, context: "", messages: [{ id: "u", role: "user" as const, content: "Read the brief" }] };

test("OpenAI Responses streams text, uses stateless requests, and replays reasoning and tool call IDs", async () => {
  const bodies: any[] = [], events: ChatEvent[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(String(url), "https://api.openai.com/v1/responses");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-only-key");
    bodies.push(JSON.parse(String(init?.body)));
    return bodies.length === 1
      ? openAIStream([{ id: "reason", type: "reasoning", summary: [], encrypted_content: "opaque-reasoning" }, { id: "fc", type: "function_call", call_id: "call_123", name: "plan_read", arguments: "{}", status: "completed" }])
      : openAIStream([{ id: "msg", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Read your brief ✓", annotations: [] }] }]);
  };
  await remoteChat("openai", "test-only-key", request, new AbortController().signal, event => events.push(event), createAgentTools("plan", null, "Saved brief", null, () => {}), fetcher);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].store, false);
  assert.deepEqual(bodies[0].include, ["reasoning.encrypted_content"]);
  assert.ok(bodies[0].tools.every((tool: any) => tool.strict && !tool.function));
  assert.ok(bodies[1].input.some((item: any) => item.encrypted_content === "opaque-reasoning"));
  assert.ok(bodies[1].input.some((item: any) => item.call_id === "call_123" && item.output === "Saved brief"));
  assert.equal(events.map(event => event.delta ?? "").join(""), "Read your brief ✓");
});

function anthropicStream(content: any[], reason: string) {
  const events: any[] = [{ type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } }];
  content.forEach((block, index) => {
    events.push({ type: "content_block_start", index, content_block: block.type === "text" ? { type: "text", text: "" } : block });
    if (block.type === "text") events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
    events.push({ type: "content_block_stop", index });
  });
  events.push({ type: "message_delta", delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 10 } }, { type: "message_stop" });
  return sse(events);
}
test("Anthropic Messages preserves signed thinking and returns tool_result blocks", async () => {
  const bodies: any[] = [], events: ChatEvent[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(String(url), "https://api.anthropic.com/v1/messages");
    assert.equal(new Headers(init?.headers).get("x-api-key"), "test-only-key");
    bodies.push(JSON.parse(String(init?.body)));
    return bodies.length === 1
      ? anthropicStream([{ type: "thinking", thinking: "", signature: "signed-fixture" }, { type: "tool_use", id: "tool_123", name: "plan_read", input: {} }], "tool_use")
      : anthropicStream([{ type: "text", text: "Read the saved brief." }], "end_turn");
  };
  await remoteChat("anthropic", "test-only-key", { ...request, model: "claude-sonnet-5-5" }, new AbortController().signal, event => events.push(event), createAgentTools("plan", null, "Saved brief", null, () => {}), fetcher);
  assert.ok(bodies[1].messages.some((message: any) => Array.isArray(message.content) && message.content.some((block: any) => block.signature === "signed-fixture")));
  assert.ok(bodies[1].messages.some((message: any) => Array.isArray(message.content) && message.content.some((block: any) => block.tool_use_id === "tool_123" && block.content === "Saved brief")));
  assert.equal(events.map(event => event.delta ?? "").join(""), "Read the saved brief.");
});

test("API errors are sanitized, catalogs use provider responses, and unfinished turns do not execute tools", async () => {
  const denied: typeof fetch = async () => new Response(JSON.stringify({ error: { message: "test-only-secret", type: "authentication_error" } }), { status: 401, headers: { "content-type": "application/json" } });
  await assert.rejects(remoteModels("openai", "test-only-secret", denied), error => !String(error).includes("test-only-secret") && /API key/.test(String(error)));
  const catalog: typeof fetch = async () => Response.json({ data: [{ id: "gpt-6-astra" }, { id: "gpt-image-2" }, { id: "gpt-5.6-terra" }] });
  assert.equal((await remoteModels("openai", "test-only-key", catalog)).length, 2);
  let executed = false;
  await assert.rejects(remoteChat("openai", "test-only-key", request, new AbortController().signal, () => {}, { definitions: [], execute: async () => { executed = true; return ""; } }, async () => openAIStream([{ id: "fc", type: "function_call", call_id: "call", name: "bad", arguments: "{}" }], "incomplete")), /before completing/);
  assert.equal(executed, false);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(remoteChat("anthropic", "test-only-key", request, controller.signal, () => {}, createAgentTools("discuss", null, "", null, () => {}), async () => { throw new Error("Must not request"); }), /abort/i);
});

test("ChatGPT uses its account catalog and restricted Responses body with namespaced tools", async () => {
  const catalog = await chatgptModels("oauth-fixture", async (url, init) => {
    assert.equal(String(url), "https://api.openai.com/v1/models");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer oauth-fixture");
    return Response.json({ models: [{ slug: "gpt-6.1-sol", display_name: "Sol", visibility: "list" }, { slug: "hidden", display_name: "Hidden", visibility: "hidden" }, { slug: "gpt-6-astra", display_name: "Astra", visibility: "list" }] });
  });
  assert.deepEqual(catalog.map(model => model.name), ["Sol", "Astra"]);
  const bodies: any[] = [];
  await remoteChat("openai", "oauth-fixture", request, new AbortController().signal, () => {}, createAgentTools("plan", null, "Brief", null, () => {}), async (url, init) => {
    assert.equal(String(url), "https://api.openai.com/v1/responses");
    bodies.push(JSON.parse(String(init?.body)));
    return bodies.length === 1
      ? openAIStream([{ id: "fc", type: "function_call", namespace: "workspace", call_id: "call_plan", name: "plan_read", arguments: "{}", status: "completed" }])
      : openAIStream([]);
  }, { chatgpt: true });
  assert.equal(bodies[0].store, false); assert.equal(bodies[0].stream, true);
  assert.equal(bodies[0].tools[0].type, "namespace"); assert.equal(bodies[0].tools[0].name, "workspace");
  assert.ok(bodies[1].input.some((item: any) => item.call_id === "call_plan" && item.output === "Brief"));
  for (const field of ["max_output_tokens", "temperature", "top_p", "previous_response_id", "conversation", "metadata"]) assert.equal(field in bodies[0], false);
});

test("ChatGPT limit failures and unknown namespaces never execute tools or retry a paid route", async () => {
  let requests = 0, executed = false;
  const tools = { definitions: [], execute: async () => { executed = true; return ""; } };
  const fetcher: typeof fetch = async () => { requests++; return sse([{ type: "response.created", response: { id: "response", object: "response", output: [], status: "in_progress" } }, { type: "response.failed", response: { id: "response", object: "response", status: "failed", output: [], error: { code: "subscription_sharing_usage_limit_exceeded", message: "private-details" } } }]); };
  await assert.rejects(remoteChat("openai", "oauth-fixture", request, new AbortController().signal, () => {}, tools, fetcher, { chatgpt: true }), /Manage usage/);
  assert.equal(requests, 1); assert.equal(executed, false);
  await assert.rejects(remoteChat("openai", "oauth-fixture", request, new AbortController().signal, () => {}, tools, async () => openAIStream([{ id: "fc", type: "function_call", namespace: "untrusted", call_id: "call", name: "plan_read", arguments: "{}" }]), { chatgpt: true }), /unknown tool namespace/);
  assert.equal(executed, false);
  await assert.rejects(chatgptModels("oauth-fixture", async () => Response.json({ detail: "private-details" }, { status: 403 })), error => /policy/.test(String(error)) && !String(error).includes("private-details"));
});
