import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Workspace } from "../src/main/workspace";
import { FileReviews } from "../src/main/file-reviews";
import { createAgentTools } from "../src/main/agent-tools";
import type { FileProposal } from "../src/shared/types";

async function fixture(run: (workspace: Workspace, reviews: FileReviews) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-gui-review-"));
  try {
    await fs.writeFile(path.join(root, "hello.ts"), "export const hello = 1;\n");
    await run(new Workspace(await fs.realpath(root)), new FileReviews());
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

test("file proposal requires a full read, writes only on approval and applies user-edited text once", () => fixture(async (workspace, reviews) => {
  let proposal: FileProposal | undefined;
  const tools = createAgentTools("build", workspace, "", null, p => { if (p.kind === "file") proposal = p; }, { files: reviews });
  const args = { path: "hello.ts", text: "export const hello = 2;\n", reason: "Update the value" };
  await assert.rejects(tools.execute("file_propose", args), /Read the complete/);
  await tools.execute("project_read", { path: "hello.ts" });
  await tools.execute("file_propose", args);
  assert.equal((await workspace.read("hello.ts")).text, "export const hello = 1;\n");
  assert.ok(proposal);
  await reviews.apply(workspace, proposal.id, "export const hello = 3;\n");
  assert.equal((await workspace.read("hello.ts")).text, "export const hello = 3;\n");
  await assert.rejects(reviews.apply(workspace, proposal.id, "bad"), /expired/);
}));

test("review rejects stale files, wrong projects, discarded handles and oversized partial reads", () => fixture(async (workspace, reviews) => {
  const observed = await workspace.read("hello.ts");
  const proposal = await reviews.propose(workspace, "hello.ts", "new", "", observed);
  await assert.rejects(reviews.apply(new Workspace(path.dirname(workspace.root)), proposal.id, "bad"), /another project/);
  await fs.writeFile(path.join(workspace.root, "hello.ts"), "external edit");
  await assert.rejects(reviews.apply(workspace, proposal.id, "bad"), /changed on disk/);
  assert.equal((await workspace.read("hello.ts")).text, "external edit");
  reviews.discard(proposal.id);
  await assert.rejects(reviews.apply(workspace, proposal.id, "bad"), /expired/);
  await fs.writeFile(path.join(workspace.root, "big.txt"), "x".repeat(25000));
  const tools = createAgentTools("build", workspace, "", null, () => {}, { files: reviews });
  await tools.execute("project_read", { path: "big.txt" });
  await assert.rejects(tools.execute("file_propose", { path: "big.txt", text: "partial", reason: "" }), /Read the complete/);
}));

test("new files never overwrite collisions; secret paths and escaping new paths are rejected", () => fixture(async (workspace, reviews) => {
  const proposal = await reviews.propose(workspace, "new.ts", "new", "");
  await assert.rejects(fs.stat(path.join(workspace.root, "new.ts")), { code: "ENOENT" });
  await reviews.apply(workspace, proposal.id, "approved new file");
  assert.equal((await workspace.read("new.ts")).text, "approved new file");
  const collision = await reviews.propose(workspace, "collision.ts", "new", "");
  await fs.writeFile(path.join(workspace.root, "collision.ts"), "someone else's work");
  await assert.rejects(reviews.apply(workspace, collision.id, "bad"), { code: "EEXIST" });
  const tools = createAgentTools("build", workspace, "", null, () => {}, { files: reviews });
  for (const file of ["../escape.ts", ".env", ".git/config"]) {
    await assert.rejects(tools.execute("file_propose", { path: file, text: "bad", reason: "" }));
  }
  const plan = createAgentTools("plan", workspace, "", null, () => {}, { files: reviews });
  await assert.rejects(plan.execute("file_propose", { path: "plan.ts", text: "bad", reason: "" }), /not permitted/);
}));
