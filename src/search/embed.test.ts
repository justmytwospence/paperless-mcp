import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadEmbedder } from "./embed.js";

// Downloads the model (~130 MB) on first run, so it only runs when asked:
// PAPERLESS_MCP_MODEL_TESTS=1 npm test
test(
  "bge-small ranks a paraphrase above an unrelated passage",
  { skip: !process.env.PAPERLESS_MCP_MODEL_TESTS },
  async () => {
    const e = await loadEmbedder("Xenova/bge-small-en-v1.5", path.join(tmpdir(), "pmcp-models"), 1);
    assert.equal(e.dims, 384);
    const [pooling, bill] = await e.embedDocuments([
      "Multilevel regression lets group-level estimates borrow strength from one another.",
      "Your electricity invoice for March is attached; the amount is due on the 15th.",
    ]);
    const q = await e.embedQuery("hierarchical models with partial pooling");
    const dot = (a: Float32Array, b: Float32Array) => a.reduce((s, x, i) => s + x * b[i], 0);
    assert.ok(dot(q, pooling) > dot(q, bill) + 0.1);
    assert.ok(e.countTokens("hello world") >= 2);
  }
);
