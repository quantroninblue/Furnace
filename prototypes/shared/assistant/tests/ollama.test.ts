import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { capabilities, chat, listModels, showModel } from "../main/ollama";
import { agentInstructions } from "../main/agent-context";
import type { ChatEvent } from "../shared/types";
import { createAgentTools } from "../main/agent-tools";
import { testContext } from "./tool-context";

test("local chat decodes split streaming chunks and sends history without tools", async () => {
  let sent: any;
  const encoded = new TextEncoder().encode(
    '{"message":{"content":"Hello "}}\n{"message":{"content":"世界"}}\n{"done":true}\n',
  );
  const fetchMock = mock.method(
    globalThis,
    "fetch",
    async (_url: string, options: RequestInit) => {
      sent = JSON.parse(String(options.body));
      return new Response(
        new ReadableStream({
          start(controller) {
            for (let index = 0; index < encoded.length; index += 3)
              controller.enqueue(encoded.slice(index, index + 3));
            controller.close();
          },
        }),
      );
    },
  );
  try {
    const events: ChatEvent[] = [];
    await chat(
      {
        id: "reply-1",
        model: "test-model",
        messages: [
          { id: "question-1", role: "user", content: "Discuss a design" },
        ],
        context: "Selected passage",
      },
      new AbortController().signal,
      (event) => events.push(event),
    );
    assert.equal(events.map((event) => event.delta).join(""), "Hello 世界");
    assert.equal(sent.tools, undefined);
    assert.equal(sent.messages[1].content, "Discuss a design");
    assert.match(sent.messages[2].content, /Selected passage/);
    assert.ok(events.every((event) => event.id === "reply-1"));
  } finally {
    fetchMock.mock.restore();
  }
});

test("local reasoning streams as thinking events, separate from the reply", async () => {
  const body = '{"message":{"thinking":"Let me "}}\n{"message":{"thinking":"check."}}\n{"message":{"content":"Done."}}\n{"done":true}\n';
  const fetchMock = mock.method(globalThis, "fetch", async () => new Response(body));
  try {
    const events: ChatEvent[] = [];
    await chat({ id: "reply-2", model: "qwen3", messages: [{ id: "q", role: "user", content: "Hi" }], context: "" },
      new AbortController().signal, (event) => events.push(event));
    assert.equal(events.map((event) => event.thinking ?? "").join(""), "Let me check.");
    assert.equal(events.map((event) => event.delta ?? "").join(""), "Done.");
  } finally {
    fetchMock.mock.restore();
  }
});

test("local server failures surface rather than becoming empty replies", async () => {
  const fetchMock = mock.method(
    globalThis,
    "fetch",
    async () => new Response('{"error":"Model unavailable"}\n'),
  );
  try {
    await assert.rejects(
      chat(
        { id: "r", model: "missing", messages: [], context: "" },
        new AbortController().signal,
        () => {},
      ),
      /Model unavailable/,
    );
  } finally {
    fetchMock.mock.restore();
  }
});

test("discovery reports only model names from the local catalog", async () => {
  const fetchMock = mock.method(globalThis, "fetch", async () =>
    Response.json({ models: [{ name: "gpt-oss:20b" }] }),
  );
  try {
    assert.deepEqual(await listModels(), ["gpt-oss:20b"]);
  } finally {
    fetchMock.mock.restore();
  }
});

test("agent loop feeds scoped tool results back into the model", async () => {
  const requests: any[] = [];
  const fetchMock = mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    requests.push(JSON.parse(String(options.body)));
    return new Response(requests.length === 1
      ? JSON.stringify({ message: { content: "", tool_calls: [{ function: { name: "plan_read", arguments: {} } }] }, done: true }) + "\n"
      : JSON.stringify({ message: { content: "I read the shared brief." }, done: true }) + "\n");
  });
  try {
    const events: ChatEvent[] = [];
    await chat({ id: "tools", model: "test", mode: "plan", messages: [], context: "" }, new AbortController().signal, event => events.push(event), createAgentTools("plan", null, testContext(), { plan: "Build a small editor" }));
    assert.equal(requests.length, 2);
    assert.equal(requests[1].messages.at(-1).role, "tool");
    assert.equal(requests[1].messages.at(-1).content, "Build a small editor");
    assert.ok(events.some(event => event.activity === "plan_read"));
    assert.ok(events.some(event => event.delta === "I read the shared brief."));
  } finally { fetchMock.mock.restore(); }
});

test("Ollama refusals keep their reason, and model capabilities are read from /api/show", async () => {
  const fetchMock = mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    if (String(url).endsWith("/api/show")) {
      const model = JSON.parse(String(options.body)).model;
      return model === "missing" ? new Response("not found", { status: 404 }) : Response.json({ capabilities: model === "qwen3-vl" ? ["completion", "vision", "tools"] : ["completion", "tools"], details: { parameter_size: "8.2B", family: "qwen3" } });
    }
    return new Response('{"error":"registry.ollama.ai/library/qwen3:8b does not support images"}', { status: 400 });
  });
  try {
    await assert.rejects(
      chat({ id: "r", model: "qwen3:8b", messages: [{ id: "q", role: "user", content: "see" }], context: "", images: [{ mime: "image/png", data: "iVBORw0KGgo=" }] },
        new AbortController().signal, () => {}),
      /^Error: Ollama returned HTTP 400: registry\.ollama\.ai\/library\/qwen3:8b does not support images$/,
    );
    assert.deepEqual(await capabilities("qwen3-vl"), ["completion", "vision", "tools"]);
    assert.deepEqual(await capabilities("qwen3:8b"), ["completion", "tools"]);
    assert.equal(await capabilities("missing"), null);
    assert.deepEqual(await showModel("qwen3:8b"), { capabilities: ["completion", "tools"], size: "8.2B", family: "qwen3" });
  } finally {
    fetchMock.mock.restore();
  }
});

test("Autocompute adds the local models' profile to Build instructions only", () => {
  const profile = "- ollama/qwen3:8b (8.2B parameters). Record: edit untested.";
  const build = agentInstructions("build", "auto", "", profile);
  assert.match(build, /Autocompute is on\. You are the lead agent[\s\S]*delegating is the default[\s\S]*- ollama\/qwen3:8b \(8\.2B parameters\)[\s\S]*assessed once[\s\S]*assess_local_models[\s\S]*medium −15, hard −35[\s\S]*smallest \(fastest\) model whose confidence reaches 50[\s\S]*review_task[\s\S]*if you delegated nothing, say why/);
  assert.doesNotMatch(agentInstructions("build", "auto", ""), /Autocompute/);
  assert.doesNotMatch(agentInstructions("plan", "auto", "", profile), /Autocompute/);
});
