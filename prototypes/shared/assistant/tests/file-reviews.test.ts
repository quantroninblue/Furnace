import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Workspace } from "../main/workspace";
import { FileReviews } from "../main/file-reviews";
import type { FileProposal } from "../shared/types";

async function fixture(run: (workspace: Workspace, reviews: FileReviews) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-gui-review-"));
  try {
    await fs.writeFile(path.join(root, "hello.ts"), "export const hello = 1;\n");
    await run(new Workspace(await fs.realpath(root)), new FileReviews());
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

test("file proposal requires a full read, writes only on approval and applies user-edited text once", () => fixture(async (workspace, reviews) => {
  await assert.rejects(reviews.propose(workspace, "hello.ts", "export const hello = 2;\n", "Update the value"), /Read the complete/);
  const proposal: FileProposal = await reviews.propose(workspace, "hello.ts", "export const hello = 2;\n", "Update the value", await workspace.read("hello.ts"));
  assert.equal((await workspace.read("hello.ts")).text, "export const hello = 1;\n");
  assert.ok(proposal);
  await reviews.apply(workspace, proposal.id, "export const hello = 3;\n");
  assert.equal((await workspace.read("hello.ts")).text, "export const hello = 3;\n");
  await assert.rejects(reviews.apply(workspace, proposal.id, "bad"), /expired/);
}));

test("review rejects stale files, wrong projects, discarded handles and handles", () => fixture(async (workspace, reviews) => {
  const observed = await workspace.read("hello.ts");
  const proposal = await reviews.propose(workspace, "hello.ts", "new", "", observed);
  await assert.rejects(reviews.apply(new Workspace(path.dirname(workspace.root)), proposal.id, "bad"), /another project/);
  await fs.writeFile(path.join(workspace.root, "hello.ts"), "external edit");
  await assert.rejects(reviews.apply(workspace, proposal.id, "bad"), /changed on disk/);
  assert.equal((await workspace.read("hello.ts")).text, "external edit");
  reviews.discard(proposal.id);
  await assert.rejects(reviews.apply(workspace, proposal.id, "bad"), /expired/);
}));

test("new files never overwrite collisions; escaping new paths are rejected", () => fixture(async (workspace, reviews) => {
  const proposal = await reviews.propose(workspace, "new.ts", "new", "");
  await assert.rejects(fs.stat(path.join(workspace.root, "new.ts")), { code: "ENOENT" });
  await reviews.apply(workspace, proposal.id, "approved new file");
  assert.equal((await workspace.read("new.ts")).text, "approved new file");
  const collision = await reviews.propose(workspace, "collision.ts", "new", "");
  await fs.writeFile(path.join(workspace.root, "collision.ts"), "someone else's work");
  await assert.rejects(reviews.apply(workspace, collision.id, "bad"), { code: "EEXIST" });
  await assert.rejects(reviews.propose(workspace, "../escape.ts", "bad", ""));
}));
