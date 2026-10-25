import assert from "node:assert/strict";
import { test } from "node:test";
import { chunkText } from "./chunk.js";

const words = (t: string) => (t.match(/\S+/g) || []).length;
const opts = (maxTokens: number, overlapTokens = 0) => ({ maxTokens, overlapTokens, countTokens: words });

test("empty and whitespace-only text has no chunks", () => {
  assert.deepEqual(chunkText("", opts(10)), []);
  assert.deepEqual(chunkText("  \n\n ", opts(10)), []);
});

test("short text is one chunk with exact offsets", () => {
  const text = "One sentence. Another one.";
  const [c] = chunkText(text, opts(50));
  assert.equal(c.text, text);
  assert.equal(c.start, 0);
  assert.equal(c.end, text.length);
});

test("chunks respect the token budget and break at sentences", () => {
  const text = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} here.`).join(" ");
  const chunks = chunkText(text, opts(20));
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.ok(words(c.text) <= 20, c.text);
    assert.match(c.text, /^Sentence number \d+ here\./);
    assert.equal(text.slice(c.start, c.end), c.text);
  }
});

test("there is no cap on the number of chunks: the last sentence is covered", () => {
  const text = Array.from({ length: 5000 }, (_, i) => `Page ${i} text.`).join(" ");
  const chunks = chunkText(text, opts(30));
  assert.ok(chunks.length > 400);
  assert.ok(chunks.at(-1)!.text.endsWith("Page 4999 text."));
});

test("consecutive chunks overlap by whole sentences and always advance", () => {
  const text = Array.from({ length: 12 }, (_, i) => `S${i} a b.`).join(" ");
  const chunks = chunkText(text, opts(8, 4));
  for (let i = 1; i < chunks.length; i++) {
    assert.ok(chunks[i].start > chunks[i - 1].start, "advances");
    assert.ok(chunks[i].start < chunks[i - 1].end, "overlaps");
  }
});

test("a run longer than the budget is split on whitespace", () => {
  const text = Array.from({ length: 100 }, (_, i) => `w${i}`).join(" ");
  const chunks = chunkText(text, opts(25));
  assert.equal(chunks.length, 4);
  for (const c of chunks) assert.ok(words(c.text) <= 25);
  assert.equal(chunks[0].text.split(" ")[0], "w0");
  assert.equal(chunks.at(-1)!.text.split(" ").at(-1), "w99");
});
