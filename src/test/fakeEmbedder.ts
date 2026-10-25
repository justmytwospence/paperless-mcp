import type { LocalEmbedder } from "../search/embed.js";
import { prepareChunks } from "../search/prepare.js";

const DIMS = 64;

function hash(word: string): number {
  let h = 2166136261;
  for (let i = 0; i < word.length; i++) {
    h ^= word.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % DIMS;
}

/**
 * Bag-of-words embeddings: texts sharing words are close. Enough to test ranking
 * and plumbing without a model; tokens are whitespace-separated words.
 */
export function fakeEmbedder(model = "fake-bow"): LocalEmbedder & { calls: string[][] } {
  const calls: string[][] = [];
  const embed = (text: string) => {
    const v = new Float32Array(DIMS);
    for (const w of text.toLowerCase().match(/[a-z0-9]+/g) || []) v[hash(w)] += 1;
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  };
  const local: LocalEmbedder & { calls: string[][] } = {
    model,
    dims: DIMS,
    calls,
    embedDocuments: async (texts) => {
      calls.push(texts);
      return texts.map(embed);
    },
    embedQuery: async (text) => embed(text),
    countTokens: (text) => (text.match(/\S+/g) || []).length,
    prepare: (input) => prepareChunks(input, local),
  };
  return local;
}
