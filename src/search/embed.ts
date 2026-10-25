import { type PrepareInput, prepareChunks, type TokenEmbedder } from "./prepare.js";
import type { StoredChunk } from "./store.js";

/** The model as the server uses it: in production a worker thread (see worker.ts). */
export interface Embedder {
  readonly model: string;
  readonly dims: number;
  embedQuery(text: string): Promise<Float32Array>;
  /** Chunks and embeds a document's changed parts (see prepareChunks). */
  prepare(input: PrepareInput): Promise<StoredChunk[]>;
  close?(): Promise<void>;
}

/** The model loaded in this thread. */
export interface LocalEmbedder extends Embedder, TokenEmbedder {}

// bge-*-en-v1.5 is trained asymmetrically: queries carry this instruction,
// passages do not.
const BGE_QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

/**
 * Local ONNX embeddings through transformers.js. CPU only, no network after the
 * first model download (cached under `cacheDir`).
 */
export async function loadEmbedder(
  model: string,
  cacheDir: string,
  threads: number,
  /** A directory holding `<model>/` files; when set, nothing is downloaded. */
  localModelDir?: string
): Promise<LocalEmbedder> {
  const { pipeline, env } = await import("@huggingface/transformers");
  env.cacheDir = cacheDir;
  if (localModelDir) {
    env.localModelPath = localModelDir;
    env.allowRemoteModels = false;
  }
  const extractor = await pipeline("feature-extraction", model, {
    dtype: "fp32",
    session_options: { intraOpNumThreads: threads, interOpNumThreads: 1 },
  });
  const tokenizer = extractor.tokenizer;
  const probe = await extractor(["probe"], { pooling: "cls", normalize: true });
  const dims = probe.dims[probe.dims.length - 1];
  const isBge = /bge-/i.test(model);

  const run = async (texts: string[]): Promise<Float32Array[]> => {
    const out = await extractor(texts, { pooling: "cls", normalize: true });
    const data = out.data as Float32Array;
    return texts.map((_, i) => data.slice(i * dims, (i + 1) * dims));
  };

  const local: LocalEmbedder = {
    model,
    dims,
    embedDocuments: run,
    embedQuery: async (text) => (await run([(isBge ? BGE_QUERY_PREFIX : "") + text]))[0],
    countTokens: (text) => tokenizer.encode(text, { add_special_tokens: false }).length,
    prepare: (input) => prepareChunks(input, local),
  };
  return local;
}
