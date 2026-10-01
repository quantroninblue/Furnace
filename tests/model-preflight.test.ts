import { test } from "node:test";
import assert from "node:assert/strict";
import { preflightModel } from "../scripts/model-preflight";

const GiB = 1024 ** 3;
test("live check requires an explicit model before making any request", async () => {
  await assert.rejects(preflightModel(undefined, 16 * GiB, async () => { throw new Error("Must not request"); }), /explicitly/);
});
test("live check refuses missing models and insufficient memory without calling inference", async () => {
  const requests: string[] = [];
  const catalog: typeof fetch = async input => {
    requests.push(String(input));
    return Response.json({ models: [{ name: "large-test-model", size: 13 * GiB }, { name: "small-test-model", size: GiB }] });
  };
  await assert.rejects(preflightModel("missing-model", 12 * GiB, catalog), /not installed/);
  await assert.rejects(preflightModel("large-test-model", 12 * GiB, catalog), /Live check refused/);
  await preflightModel("small-test-model", 12 * GiB, catalog);
  assert.deepEqual(requests, Array(3).fill("http://127.0.0.1:11434/api/tags"));
});
