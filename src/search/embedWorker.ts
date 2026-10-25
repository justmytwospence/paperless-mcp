// The embedding worker: loads the model in its own thread and answers query and
// prepare (chunk + embed) requests from the main thread. See worker.ts.

import { parentPort, workerData } from "node:worker_threads";
import { loadEmbedder } from "./embed.js";
import type { WorkerInit, WorkerRequest, WorkerResponse } from "./worker.js";

const port = parentPort!;
const init = workerData as WorkerInit;
const ready = loadEmbedder(init.model, init.cacheDir, init.threads, init.localModelDir);

const send = (msg: WorkerResponse, transfer: ArrayBuffer[] = []) =>
  port.postMessage(msg, [...new Set(transfer)]);

ready.then(
  (e) => send({ type: "ready", dims: e.dims }),
  (err) => send({ type: "fatal", error: err instanceof Error ? err.stack || err.message : String(err) })
);

// Requests are not serialised: a query is answered between a long document's
// embedding batches rather than after the whole document.
port.on("message", async (req: WorkerRequest) => {
  try {
    const e = await ready;
    if (req.op === "query") {
      const vector = await e.embedQuery(req.text);
      send({ type: "result", id: req.id, vector }, [vector.buffer as ArrayBuffer]);
    } else {
      const chunks = await e.prepare(req.input);
      send(
        { type: "result", id: req.id, chunks },
        chunks.map((c) => c.embedding.buffer as ArrayBuffer)
      );
    }
  } catch (err) {
    send({ type: "error", id: req.id, error: err instanceof Error ? err.message : String(err) });
  }
});
