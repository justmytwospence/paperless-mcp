import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setPublicUrl } from "../api/documentLinks.js";
import { fakeEmbedder } from "../test/fakeEmbedder.js";
import { FakePaperless } from "../test/fakePaperless.js";
import { SemanticSearch } from "./search.js";
import { VectorStore } from "./store.js";
import { Syncer } from "./sync.js";

setPublicUrl("https://p.test");

const LONG_BOOK = Array.from({ length: 400 }, (_, i) =>
  i === 390
    ? "Chapter twenty: the Gibbs sampler for hierarchical shrinkage priors."
    : `Filler sentence ${i} about nothing in particular.`
).join(" ");

function setup(opts: { file?: string; model?: string } = {}) {
  const paperless = new FakePaperless();
  paperless.add({ id: 1, title: "Bayesian hierarchical models", content: "Partial pooling of group means with hierarchical priors.", tags: [1], created_date: "2020-05-01" });
  paperless.add({ id: 2, title: "Electricity bill", content: "Your power invoice for March. Amount due.", tags: [2], created_date: "2024-03-01" });
  paperless.add({ id: 3, title: "A long textbook", content: LONG_BOOK, tags: [1], created_date: "2015-01-01" });
  const embedder = fakeEmbedder(opts.model);
  const store = new VectorStore(opts.file ?? ":memory:", embedder.model, embedder.dims);
  const syncer = new Syncer(paperless.api, store, embedder, {
    chunkTokens: 40,
    overlapTokens: 8,
    retryDelayMs: 0,
    log: () => {},
  });
  const search = new SemanticSearch(paperless.api, store, embedder, () => syncer.getStatus());
  return { paperless, embedder, store, syncer, search };
}

test("reconcile indexes every document and reports full coverage", async () => {
  const { syncer, store } = setup();
  await syncer.reconcile();
  const status = syncer.getStatus();
  assert.equal(status.documents_indexed, 3);
  assert.equal(status.documents_total, 3);
  assert.equal(status.last_error, null);
  assert.ok(store.counts().chunks > 20, "the long book is chunked to the end");
});

test("semantic_search ranks by meaning and returns passages with offsets", async () => {
  const { syncer, search, paperless } = setup();
  await syncer.reconcile();
  const res = await search.search({ query: "hierarchical priors partial pooling", hybrid: false });
  assert.equal(res.results[0].id, 1);
  assert.equal(res.results[0].web_url, "https://p.test/documents/1/details");
  assert.deepEqual(res.results[0].matched_by, ["semantic"]);
  assert.equal(res.index.complete, true);

  // A passage deep in a long document is found, and its offset reads it back.
  const deep = await search.search({ query: "Gibbs sampler shrinkage", hybrid: false, limit: 1 });
  const hit = deep.results[0];
  assert.equal(hit.id, 3);
  const passage = hit.passages.find((p) => p.kind === "content")!;
  const content = paperless.docs.get(3)!.content!;
  assert.match(content.slice(passage.offset!, passage.offset! + passage.length!), /Gibbs sampler/);
});

test("filters are applied by Paperless before ranking", async () => {
  const { syncer, search } = setup();
  await syncer.reconcile();
  const res = await search.search({ query: "invoice power march", tag_ids: [1], hybrid: false });
  assert.ok(res.results.every((r) => r.id !== 2));
  const dated = await search.search({ query: "invoice", created_after: "2023-01-01", hybrid: false });
  assert.deepEqual(dated.results.map((r) => r.id), [2]);
});

test("hybrid fuses keyword hits and marks how each document matched", async () => {
  const { syncer, search } = setup();
  await syncer.reconcile();
  const res = await search.search({ query: "invoice" });
  const bill = res.results.find((r) => r.id === 2)!;
  assert.deepEqual(bill.matched_by, ["semantic", "keyword"]);
  assert.equal(bill.keyword_rank, 1);
  assert.equal(res.results[0].id, 2);
});

test("unchanged documents are not re-embedded; a tag change re-embeds only metadata", async () => {
  const { syncer, embedder, paperless } = setup();
  await syncer.reconcile();
  const before = embedder.calls.flat().length;

  paperless.update(3, {}, new Date(Date.now() + 1000).toISOString());
  await syncer.incremental();
  assert.equal(embedder.calls.flat().length, before, "modified bump with same text: no embedding");

  paperless.update(3, { tags: [1, 2] }, new Date(Date.now() + 2000).toISOString());
  await syncer.incremental();
  const embedded = embedder.calls.flat().slice(before);
  assert.ok(embedded.length >= 1 && embedded.length <= 2, `only metadata chunks, got ${embedded.length}`);
  assert.ok(embedded.every((t) => t.includes("Tags:") || !t.includes("Filler")));
});

test("content edits are picked up by the incremental pass", async () => {
  const { syncer, search, paperless } = setup();
  await syncer.reconcile();
  paperless.update(2, { content: "Quarterly dividend statement from the brokerage." }, new Date(Date.now() + 5000).toISOString());
  await syncer.incremental();
  const res = await search.search({ query: "dividend brokerage", hybrid: false, limit: 1 });
  assert.equal(res.results[0].id, 2);
});

test("new notes are indexed by reconcile even though modified did not change", async () => {
  const { syncer, search, paperless } = setup();
  await syncer.reconcile();
  const doc = paperless.docs.get(2)!;
  doc.notes = [{ id: 1, note: "Annotation: compare with the zebrafish experiment.", created: "", user: { id: 1, username: "s" } }];
  await syncer.reconcile();
  const res = await search.search({ query: "zebrafish experiment", hybrid: false });
  const hit = res.results.find((r) => r.id === 2)!;
  assert.ok(hit.similarity! > 0);
  assert.equal(hit.passages[0].kind, "meta");
  assert.match(hit.passages[0].text, /zebrafish/);
});

test("deleted documents leave the index", async () => {
  const { syncer, search, paperless } = setup();
  await syncer.reconcile();
  paperless.docs.delete(2);
  await syncer.reconcile();
  assert.equal(syncer.getStatus().documents_indexed, 2);
  const res = await search.search({ query: "invoice power", hybrid: false });
  assert.ok(res.results.every((r) => r.id !== 2));
});

test("the index survives a restart, and a model change rebuilds it", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pmcp-index-"));
  const file = path.join(dir, "index.db");
  try {
    const a = setup({ file });
    await a.syncer.reconcile();
    a.store.close();

    const b = setup({ file });
    assert.equal(b.store.counts().documents, 3);
    await b.syncer.reconcile();
    assert.equal(b.embedder.calls.length, 0, "nothing re-embedded after restart");
    b.store.close();

    const c = setup({ file, model: "another-model" });
    assert.equal(c.store.counts().documents, 0);
    c.store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a document that cannot be fetched is retried, then skipped without stopping the pass", async () => {
  const { syncer, paperless } = setup();
  paperless.failures.set(2, 1); // fails once: the retry succeeds
  paperless.failures.set(3, 99); // keeps failing
  await syncer.reconcile();
  const status = syncer.getStatus();
  assert.equal(status.documents_indexed, 2, "documents 1 and 2 indexed despite 3");
  assert.match(status.last_error!, /1 document\(s\) not indexed.*3 \(terminated\)/);

  await syncer.incremental();
  assert.ok(syncer.getStatus().last_error, "an incremental success does not hide the reconcile gap");

  paperless.failures.delete(3);
  await syncer.reconcile();
  assert.equal(syncer.getStatus().documents_indexed, 3);
  assert.equal(syncer.getStatus().last_error, null);
});
