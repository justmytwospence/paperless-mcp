import { chunkText } from "./chunk.js";
import type { StoredChunk } from "./store.js";

/** What indexing one document needs from the model: its changed parts, chunked and embedded. */
export interface PrepareInput {
  title: string;
  /** The metadata text (with notes), or null when it did not change. */
  meta: string | null;
  /** The document content, or null when it did not change. */
  content: string | null;
  chunkTokens: number;
  overlapTokens: number;
  batchSize?: number;
}

/** The two model operations chunking and embedding need, run where the model lives. */
export interface TokenEmbedder {
  embedDocuments(texts: string[]): Promise<Float32Array[]>;
  countTokens(text: string): number;
}

/**
 * Chunks a document's changed parts and embeds every chunk. This is the CPU-heavy
 * half of indexing (tokenizing a book takes seconds), so in production it runs in
 * the embedding worker, off the thread that answers requests.
 */
export async function prepareChunks(input: PrepareInput, model: TokenEmbedder): Promise<StoredChunk[]> {
  const count = (t: string) => model.countTokens(t);
  const titlePrefix = `${input.title}\n\n`;
  const budget = Math.max(64, input.chunkTokens - count(titlePrefix));
  const chunks: Array<Omit<StoredChunk, "embedding"> & { embedText: string }> = [];

  if (input.meta !== null) {
    chunkText(input.meta, {
      maxTokens: input.chunkTokens,
      overlapTokens: input.overlapTokens,
      countTokens: count,
    }).forEach((c, i) =>
      chunks.push({
        chunk_no: -(i + 1),
        kind: "meta",
        start: null,
        end: null,
        text: c.text,
        embedText: i === 0 ? c.text : titlePrefix + c.text,
      })
    );
  }
  if (input.content !== null) {
    chunkText(input.content, {
      maxTokens: budget,
      overlapTokens: input.overlapTokens,
      countTokens: count,
    }).forEach((c, i) =>
      chunks.push({
        chunk_no: i,
        kind: "content",
        start: c.start,
        end: c.end,
        text: c.text,
        embedText: titlePrefix + c.text,
      })
    );
  }

  const batch = input.batchSize ?? 8;
  const stored: StoredChunk[] = [];
  for (let i = 0; i < chunks.length; i += batch) {
    const slice = chunks.slice(i, i + batch);
    const vectors = await model.embedDocuments(slice.map((c) => c.embedText));
    slice.forEach(({ embedText: _e, ...c }, j) => stored.push({ ...c, embedding: vectors[j] }));
  }
  return stored;
}
