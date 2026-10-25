import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadEmbedder } from "./embed.js";
import { loadWorkerEmbedder } from "./worker.js";

// Needs the model: PAPERLESS_MCP_MODEL_TESTS=1 (and PAPERLESS_MCP_MODEL_DIR for a
// local copy, else it is downloaded).
test(
  "the worker embeds exactly what the in-thread model does, without blocking this thread",
  { skip: !process.env.PAPERLESS_MCP_MODEL_TESTS },
  async () => {
    const init = {
      model: "Xenova/bge-small-en-v1.5",
      cacheDir: path.join(tmpdir(), "pmcp-models"),
      threads: 1,
      localModelDir: process.env.PAPERLESS_MCP_MODEL_DIR,
    };
    const worker = await loadWorkerEmbedder(init);
    const local = await loadEmbedder(init.model, init.cacheDir, 1, init.localModelDir);
    try {
      assert.equal(worker.dims, 384);
      const q = "hierarchical models with partial pooling";
      assert.deepEqual([...(await worker.embedQuery(q))], [...(await local.embedQuery(q))]);

      const input = {
        title: "A long book",
        meta: "Title: A long book",
        content: "Partial pooling shrinks group estimates toward the mean. ".repeat(3000),
        chunkTokens: 256,
        overlapTokens: 32,
      };
      // The main thread keeps ticking while the worker chunks and embeds.
      let ticks = 0;
      const timer = setInterval(() => ticks++, 10);
      const viaWorker = await worker.prepare(input);
      clearInterval(timer);
      const inThread = await local.prepare(input);
      assert.equal(viaWorker.length, inThread.length);
      assert.deepEqual(viaWorker.map((c) => [c.kind, c.chunk_no, c.start, c.text]), inThread.map((c) => [c.kind, c.chunk_no, c.start, c.text]));
      assert.ok(viaWorker[0].embedding instanceof Float32Array);
      assert.deepEqual([...viaWorker[5].embedding], [...inThread[5].embedding]);
      assert.ok(ticks > 10, `main thread ticked only ${ticks} times`);
    } finally {
      await worker.close?.();
    }
  }
);
