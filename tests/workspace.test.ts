import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspace } from "../src/main/workspace";

async function fixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "ai-gui-unit-"));
  const root = path.join(base, "project");
  await fs.mkdir(root);
  return {
    base,
    root,
    workspace: new Workspace(await fs.realpath(root)),
    clean: () => fs.rm(base, { recursive: true, force: true }),
  };
}

test("project paths reject traversal, absolute paths and escaping symlinks", async () => {
  const f = await fixture();
  try {
    const outside = path.join(f.base, "secret.txt");
    await fs.writeFile(outside, "private");
    await fs.symlink(outside, path.join(f.root, "escape.txt"));
    await assert.rejects(f.workspace.read("../secret.txt"), /outside/);
    await assert.rejects(f.workspace.read(outside), /relative/);
    await assert.rejects(f.workspace.read("escape.txt"), /outside/);
    assert.equal((await f.workspace.list()).length, 0);
  } finally {
    await f.clean();
  }
});

test("save refuses stale content and preserves external edits", async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.root, "index.ts"), "original\n");
    const document = await f.workspace.read("index.ts");
    await fs.writeFile(path.join(f.root, "index.ts"), "changed outside\n");
    await assert.rejects(
      f.workspace.save({ ...document, text: "my edit\n" }),
      /changed on disk/,
    );
    assert.equal(
      await fs.readFile(path.join(f.root, "index.ts"), "utf8"),
      "changed outside\n",
    );
    const fresh = await f.workspace.read("index.ts");
    const saved = await f.workspace.save({ ...fresh, text: "new text\n" });
    assert.notEqual(saved.revision, fresh.revision);
    assert.equal((await f.workspace.read("index.ts")).text, "new text\n");
  } finally {
    await f.clean();
  }
});

test("attachment imports copy without modifying source or overwriting equal names", async () => {
  const f = await fixture();
  try {
    const source = path.join(f.base, "notes.md");
    await fs.writeFile(source, "# Research");
    const [first, second] = await f.workspace.importFiles([source, source]);
    assert.notEqual(first.path, second.path);
    assert.equal(first.text, "# Research");
    assert.equal(await fs.readFile(source, "utf8"), "# Research");
    assert.equal((await f.workspace.read(second.path)).text, "# Research");
  } finally {
    await f.clean();
  }
});

test("attachment directory cannot point outside the project", async () => {
  const f = await fixture();
  try {
    await fs.mkdir(path.join(f.base, "outside"));
    await fs.symlink(
      path.join(f.base, "outside"),
      path.join(f.root, "attachments"),
      "dir",
    );
    await fs.writeFile(path.join(f.base, "source.txt"), "test");
    await assert.rejects(
      f.workspace.importFiles([path.join(f.base, "source.txt")]),
      /outside/,
    );
    assert.deepEqual(await fs.readdir(path.join(f.base, "outside")), []);
  } finally {
    await f.clean();
  }
});

test("binary files and oversized text are rejected by the editor", async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.root, "binary"), Buffer.from([0, 1, 2, 3]));
    await fs.writeFile(
      path.join(f.root, "large"),
      Buffer.alloc(2 * 1024 * 1024 + 1, 65),
    );
    await assert.rejects(f.workspace.read("binary"), /binary/);
    await assert.rejects(f.workspace.read("large"), /2 MB/);
  } finally {
    await f.clean();
  }
});
