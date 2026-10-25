export interface Embedder {
  readonly model: string;
  readonly dims: number;
  embedDocuments(texts: string[]): Promise<Float32Array[]>;
  embedQuery(text: string): Promise<Float32Array>;
  countTokens(text: string): number;
}

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
): Promise<Embedder> {
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

  return {
    model,
    dims,
    embedDocuments: run,
    embedQuery: async (text) => (await run([(isBge ? BGE_QUERY_PREFIX : "") + text]))[0],
    countTokens: (text) => tokenizer.encode(text, { add_special_tokens: false }).length,
  };
}
