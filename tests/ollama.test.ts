import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { chat, listModels } from "../src/main/ollama";
import type { ChatEvent } from "../src/shared/types";
import { createAgentTools } from "../src/main/agent-tools";

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
    await chat({ id: "tools", model: "test", mode: "plan", messages: [], context: "" }, new AbortController().signal, event => events.push(event), createAgentTools("plan", null, "Build a small editor", null, () => {}));
    assert.equal(requests.length, 2);
    assert.equal(requests[1].messages.at(-1).role, "tool");
    assert.equal(requests[1].messages.at(-1).content, "Build a small editor");
    assert.ok(events.some(event => event.activity === "plan_read"));
    assert.ok(events.some(event => event.delta === "I read the shared brief."));
  } finally { fetchMock.mock.restore(); }
});
