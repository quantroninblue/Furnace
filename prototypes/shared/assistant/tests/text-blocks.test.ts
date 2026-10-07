import { test } from "node:test";
import assert from "node:assert/strict";
import { textBlocks } from "../main/text-blocks";

test("separate text blocks join as paragraphs without doubling existing breaks", () => {
  const out: string[] = [], blocks = textBlocks(text => out.push(text));
  blocks.boundary(); blocks.text("Files reverted"); blocks.text(".");
  blocks.boundary(); blocks.boundary(); blocks.text("Since the tests pass");
  blocks.boundary(); blocks.text(", done.\n\n");
  blocks.boundary(); blocks.text("Next");
  blocks.boundary(); blocks.text("");
  assert.equal(out.join(""), "Files reverted.\n\nSince the tests pass\n\n, done.\n\nNext");
});
