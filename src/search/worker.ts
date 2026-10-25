// Runs the embedding model in a worker thread. Tokenizing and chunking a long
// document is synchronous JavaScript that takes seconds; on the main thread it
// stalled every request (and the /health check) while the index was being built.

import { Worker } from "node:worker_threads";
import type { Embedder } from "./embed.js";
import type { PrepareInput } from "./prepare.js";
import type { StoredChunk } from "./store.js";

export interface WorkerInit {
  model: string;
  cacheDir: string;
  threads: number;
  localModelDir?: string;
}

type Request = { op: "query"; text: string } | { op: "prepare"; input: PrepareInput };

export type WorkerRequest = Request & { id: number };

export type WorkerResponse =
  | { type: "ready"; dims: number }
  | { type: "fatal"; error: string }
  | { type: "result"; id: number; vector?: Float32Array; chunks?: StoredChunk[] }
  | { type: "error"; id: number; error: string };

type Pending = { resolve: (value: any) => void; reject: (err: Error) => void };

/** The worker's entry point, next to this file (.ts when run from source under tsx). */
function workerUrl(): { url: URL; execArgv?: string[] } {
  const fromSource = import.meta.url.endsWith(".ts");
  return {
    url: new URL(fromSource ? "./embedWorker.ts" : "./embedWorker.js", import.meta.url),
    execArgv: fromSource ? ["--import", "tsx"] : undefined,
  };
}

/**
 * An Embedder backed by a worker thread. Resolves once the model has loaded (and
 * rejects if it cannot). A worker that dies is replaced on the next request; the
 * requests it was holding fail and are retried by their callers (the indexer
 * retries on its next pass, a search reports the error).
 */
export async function loadWorkerEmbedder(init: WorkerInit): Promise<Embedder> {
  let worker: Worker | undefined;
  let starting: Promise<number> | undefined;
  let closed = false;
  let nextId = 1;
  const pending = new Map<number, Pending>();

  const failAll = (err: Error) => {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };

  const start = (): Promise<number> =>
    (starting ??= new Promise<number>((resolve, reject) => {
      const { url, execArgv } = workerUrl();
      const w = new Worker(url, { workerData: init, execArgv });
      worker = w;
      w.on("message", (msg: WorkerResponse) => {
        if (msg.type === "ready") return resolve(msg.dims);
        if (msg.type === "fatal") {
          reject(new Error(`embedding model failed to load: ${msg.error}`));
          void w.terminate();
          return;
        }
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (msg.type === "error") p.reject(new Error(msg.error));
        else p.resolve(msg.vector ?? msg.chunks);
      });
      w.on("error", (err) => {
        reject(err);
        failAll(err);
      });
      w.on("exit", (code) => {
        if (worker === w) {
          worker = undefined;
          starting = undefined;
        }
        reject(new Error(`embedding worker exited (code ${code}) before it was ready`));
        if (!closed) {
          console.error(`embedding worker exited (code ${code}); it restarts on the next request`);
        }
        failAll(new Error(`embedding worker exited (code ${code})`));
      });
    }));

  const call = async <T>(req: Request): Promise<T> => {
    if (closed) throw new Error("embedder is closed");
    await start();
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      if (!worker) return reject(new Error("embedding worker is not running"));
      pending.set(id, { resolve, reject });
      worker.postMessage({ ...req, id });
    });
  };

  const dims = await start();
  return {
    model: init.model,
    dims,
    embedQuery: (text) => call<Float32Array>({ op: "query", text }),
    prepare: (input) => call<StoredChunk[]>({ op: "prepare", input }),
    close: async () => {
      closed = true;
      failAll(new Error("embedder is closed"));
      await worker?.terminate();
    },
  };
}
