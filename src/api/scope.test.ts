import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { OutOfScopeError, PaperlessAPI } from "./PaperlessAPI.js";

// A stub Paperless behind fetch, so the real client (and its scope) is exercised.
const DOCS = [
  { id: 1, title: "Paper", document_type: 1 },
  { id: 2, title: "Invoice", document_type: 17 },
  { id: 3, title: "Untyped", document_type: null },
];
const TYPES = [
  { id: 1, name: "Academic" },
  { id: 17, name: "Invoice" },
];

let calls: Array<{ method: string; url: URL; body?: unknown }> = [];
const realFetch = globalThis.fetch;

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method || "GET";
    calls.push({ method, url, body: init.body });
    const p = url.pathname;
    if (p === "/api/document_types/") return json({ count: 2, next: null, results: TYPES });
    if (p === "/api/documents/") {
      // Django: the last value of a repeated parameter wins.
      const inTypes = url.searchParams.getAll("document_type__id__in").at(-1);
      const ids = url.searchParams.get("id__in");
      let docs = DOCS;
      if (inTypes) docs = docs.filter((d) => d.document_type !== null && inTypes.split(",").map(Number).includes(d.document_type));
      if (ids) docs = docs.filter((d) => ids.split(",").map(Number).includes(d.id));
      return json({ count: docs.length, next: null, results: docs });
    }
    const m = p.match(/^\/api\/documents\/(\d+)\/(notes\/|download\/|thumb\/)?$/);
    if (m) {
      const doc = DOCS.find((d) => d.id === Number(m[1]));
      if (!doc) return json({ detail: "No Document matches the given query." }, 404);
      if (m[2] === "notes/") return json([]);
      if (m[2]) return new Response("bytes", { headers: { "content-type": "application/pdf" } });
      return json(method === "PATCH" ? { ...doc, ...JSON.parse(String(init.body)) } : doc);
    }
    if (p === "/api/documents/bulk_edit/") return json({ result: "OK" });
    if (p === "/api/documents/post_document/") return json("task-uuid");
    return json({ detail: "not found" }, 404);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const scoped = () => new PaperlessAPI("http://p.test", "t", { documentTypes: ["academic"] });

test("an unscoped client sees everything and adds no filter", async () => {
  const api = new PaperlessAPI("http://p.test", "t");
  const res = await api.getDocuments("?page_size=10");
  assert.equal(res.results.length, 3);
  assert.equal(calls[0].url.searchParams.has("document_type__id__in"), false);
});

test("type names resolve case-insensitively to ids", async () => {
  assert.deepEqual(await scoped().scopeTypeIds(), [1]);
  await assert.rejects(
    new PaperlessAPI("http://p.test", "t", { documentTypes: ["Nope"] }).scopeTypeIds(),
    /no document type "Nope"/
  );
});

test("every list and search is confined, and a caller's own type filter cannot widen it", async () => {
  const api = scoped();
  assert.deepEqual((await api.getDocuments("")).results.map((d) => d.id), [1]);
  const widened = await api.getDocuments("?document_type__id__in=1,17");
  assert.deepEqual(widened.results.map((d) => d.id), [1]);
});

test("documents outside the scope look like documents that do not exist", async () => {
  const api = scoped();
  assert.equal((await api.getDocument(1)).title, "Paper");
  for (const id of [2, 3, 99]) {
    await assert.rejects(api.getDocument(id), OutOfScopeError, `get ${id}`);
  }
  await assert.rejects(api.getDocumentNotes(2), OutOfScopeError);
  await assert.rejects(api.createDocumentNote(2, "x"), OutOfScopeError);
  await assert.rejects(api.deleteDocumentNote(2, 1), OutOfScopeError);
  await assert.rejects(api.downloadDocument(2), OutOfScopeError);
  await assert.rejects(api.getThumbnail(2), OutOfScopeError);
  await assert.rejects(api.updateDocument(2, { title: "x" }), OutOfScopeError);
  await assert.rejects(api.bulkEditDocuments([1, 2], "add_tag", { tag: 5 }), OutOfScopeError);
  assert.ok(!calls.some((c) => c.method !== "GET" && /documents\/2\//.test(c.url.pathname)), "no write reached Paperless");
});

test("a document cannot be moved out of the scope", async () => {
  const api = scoped();
  await assert.rejects(api.updateDocument(1, { document_type: 17 }), OutOfScopeError);
  await assert.rejects(api.updateDocument(1, { document_type: null }), OutOfScopeError);
  await api.updateDocument(1, { title: "Renamed" });
  await assert.rejects(
    api.bulkEditDocuments([1], "set_document_type", { document_type: 17 }),
    OutOfScopeError
  );
});

test("uploads are filed as the scope's type unless another in-scope type is given", async () => {
  const api = scoped();
  await api.postDocument(Buffer.from("%PDF-"), "a.pdf", { title: "A" });
  const form = calls.at(-1)!.body as FormData;
  assert.equal(form.get("document_type"), "1");
  await assert.rejects(
    api.postDocument(Buffer.from("%PDF-"), "b.pdf", { document_type: 17 }),
    OutOfScopeError
  );
});

test("raw requests cannot reach documents around the scope", async () => {
  await assert.rejects(scoped().request("/documents/2/"), /use the document methods/);
});

const excluding = () => new PaperlessAPI("http://p.test", "t", { excludeDocumentTypes: ["Academic"] });

test("an exclude scope sees everything else, untyped documents included", async () => {
  const api = excluding();
  const list = await api.getDocuments("");
  assert.equal(calls.at(-1)!.url.searchParams.get("document_type__id__none"), "1");
  assert.equal((await api.getDocument(2)).title, "Invoice");
  assert.equal((await api.getDocument(3)).title, "Untyped");
  await assert.rejects(api.getDocument(1), OutOfScopeError);
  await assert.rejects(api.updateDocument(2, { document_type: 1 }), OutOfScopeError);
  await api.updateDocument(2, { document_type: null });
  assert.ok(list);
});

test("an exclude scope files uploads untyped unless told otherwise, and never as excluded", async () => {
  const api = excluding();
  await api.postDocument(Buffer.from("%PDF-"), "a.pdf", {});
  assert.equal((calls.at(-1)!.body as FormData).get("document_type"), null);
  await assert.rejects(api.postDocument(Buffer.from("%PDF-"), "b.pdf", { document_type: 1 }), OutOfScopeError);
  const typed = new PaperlessAPI("http://p.test", "t", {
    excludeDocumentTypes: ["Academic"],
    uploadDocumentType: "Invoice",
  });
  await typed.postDocument(Buffer.from("%PDF-"), "c.pdf", {});
  assert.equal((calls.at(-1)!.body as FormData).get("document_type"), "17");
});

test("include and exclude together, or an upload type outside the scope, are refused", async () => {
  await assert.rejects(
    new PaperlessAPI("http://p.test", "t", { documentTypes: ["Academic"], excludeDocumentTypes: ["Invoice"] }).scope(),
    /not both/
  );
  await assert.rejects(
    new PaperlessAPI("http://p.test", "t", { documentTypes: ["Academic"], uploadDocumentType: "Invoice" }).scope(),
    /outside the library/
  );
});
