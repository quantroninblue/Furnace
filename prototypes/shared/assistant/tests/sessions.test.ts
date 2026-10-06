import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Sessions } from "../main/sessions";

test("launch and new chat create fresh sessions; explicit resume restores only the matching project", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-gui-sessions-"));
  try {
    const sessions = new Sessions(path.join(directory, "sessions"), path.join(directory, "legacy"));
    const first = sessions.current();
    await sessions.write({ ...first, messages: [{ id: "user", role: "user", content: "Design an editor" }], model: "openai/gpt-6-astra", plan: "A useful brief" }, null);
    const second = sessions.start(null);
    assert.notEqual(second.id, first.id);
    assert.deepEqual(second.messages, []);
    await assert.rejects(sessions.write(first, null), /Session changed/);
    assert.equal((await sessions.list(null))[0].title, "Design an editor");
    assert.deepEqual(await sessions.list("/another-project"), []);
    await assert.rejects(sessions.resume(first.id, "/another-project"), /project/);
    const restored = await sessions.resume(first.id, null);
    assert.equal(restored.plan, "A useful brief");
    assert.equal(restored.model, "openai/gpt-6-astra");
    const relaunched = new Sessions(path.join(directory, "sessions"), path.join(directory, "legacy"));
    assert.deepEqual(relaunched.current().messages, []);
    assert.equal((await relaunched.list(null)).length, 1);
    assert.equal((await relaunched.resume(first.id, null)).messages[0].content, "Design an editor");
    await assert.rejects(relaunched.resume("../outside", null), /Invalid session ID/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("legacy chat is imported once without deleting the original", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-gui-legacy-"));
  try {
    const legacy = path.join(directory, "legacy"); await fs.mkdir(legacy);
    await fs.writeFile(path.join(legacy, "quick-chat.json"), JSON.stringify({ messages: [{ id: "user", role: "user", content: "Old conversation" }], model: "gpt-oss:20b", plan: "Original plan" }));
    const sessions = new Sessions(path.join(directory, "sessions"), legacy);
    const listed = await sessions.list(null);
    assert.equal(listed.length, 1);
    assert.equal((await sessions.list(null)).length, 1);
    assert.equal((await sessions.resume(listed[0].id, null)).plan, "Original plan");
    await fs.access(path.join(legacy, "quick-chat.json"));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("oversized and failed saves preserve the last saved state and later writes can recover", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-gui-failed-save-"));
  try {
    const destination = path.join(directory, "sessions");
    const sessions = new Sessions(destination, path.join(directory, "legacy"));
    const first = sessions.current();
    await assert.rejects(sessions.write({ ...first, plan: "x".repeat(4 * 1024 * 1024) }, null), /4 MB/);
    assert.equal(sessions.current().plan, "");
    // A regular file blocks directory creation without relying on permissions or root behavior.
    await fs.writeFile(destination, "blocked directory");
    await assert.rejects(sessions.write({ ...first, plan: "Unsaved update" }, null));
    assert.equal(sessions.current().plan, "");
    await fs.rm(destination);
    await sessions.write({ ...first, plan: "Recovered update" }, null);
    assert.equal(sessions.current().plan, "Recovered update");
    const restored = await sessions.resume(first.id, null);
    assert.equal(restored.plan, "Recovered update");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("an in-flight save cannot replace a newly started session", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-gui-save-race-"));
  try {
    const sessions = new Sessions(path.join(directory, "sessions"), path.join(directory, "legacy"));
    const first = sessions.current();
    const pending = sessions.write({ ...first, plan: "Previous conversation" }, null);
    const next = sessions.start(null);
    await pending;
    assert.equal(sessions.current().id, next.id);
    assert.equal(sessions.current().plan, "");
    assert.equal((await sessions.resume(first.id, null)).plan, "Previous conversation");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
