import assert from "node:assert/strict";
import { test } from "node:test";
import { PaperlessAPI } from "../api/PaperlessAPI.js";
import { setPublicUrl } from "../api/documentLinks.js";
import { RequestPolicy } from "../api/requestPolicy.js";
import { createServerFactory } from "../server.js";
import { createDocument } from "../test/mocks/paperlessApi.js";
import { parseResourceText, parseToolText, withServer } from "../test/mcp.js";
import type { SyncStatus } from "../search/sync.js";
import type { SemanticSearch } from "../search/search.js";

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });

test("actual clients cannot read or enumerate across include/exclude libraries through any template", async () => {
  const realFetch = globalThis.fetch;
  const calls: Array<{ path: string; method: string }> = [];
  const docs = [
    createDocument({ id: 1, document_type: 10, title: "Research only", content: "R".repeat(40_000) }),
    createDocument({ id: 2, document_type: 20, title: "Household only", content: "H".repeat(40_000) }),
    createDocument({ id: 3, document_type: null, title: "Untyped household" }),
  ];
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ path: url.pathname, method: init.method ?? "GET" });
    assert.equal(init.method ?? "GET", "GET", "resource/discovery must not write");
    if (url.pathname === "/api/document_types/") return json({ results: [{ id: 10, name: "Research" }, { id: 20, name: "Household" }] });
    if (url.pathname === "/api/documents/") {
      let filtered = docs;
      const include = url.searchParams.getAll("document_type__id__in").at(-1);
      const exclude = url.searchParams.getAll("document_type__id__none").at(-1);
      assert.ok(include || exclude, "no unscoped enumeration");
      if (include) filtered = filtered.filter((d) => d.document_type !== null && include.split(",").map(Number).includes(d.document_type));
      if (exclude) filtered = filtered.filter((d) => d.document_type === null || !exclude.split(",").map(Number).includes(d.document_type));
      const ids = url.searchParams.get("id__in");
      if (ids) filtered = filtered.filter((d) => ids.split(",").map(Number).includes(d.id));
      return json({ count: filtered.length, all: filtered.map((d) => d.id), results: filtered });
    }
    const match = url.pathname.match(/^\/api\/documents\/(\d+)\/(notes\/|download\/|thumb\/)?$/);
    if (match) {
      const doc = docs.find((d) => d.id === Number(match[1]));
      if (!doc) return json({ detail: "missing" }, 404);
      if (match[2] === "notes/") return json(Array.from({ length: 55 }, (_, i) => ({ id: i + 1, note: doc.title.repeat(300), created: "2025-01-01", user: { username: "not exposed" } })));
      if (match[2]) return new Response(doc.title, { headers: { "content-type": "application/pdf" } });
      return json(doc);
    }
    throw new Error(`Unexpected call ${url}`);
  }) as typeof fetch;
  setPublicUrl("http://p.test");
  const policy = new RequestPolicy({ concurrency: 2 });
  const libraries = [
    { name: "research", api: new PaperlessAPI("http://p.test", "fake", { documentTypes: ["10"], requestPolicy: policy }), own: 1, hidden: 2 },
    { name: "household", api: new PaperlessAPI("http://p.test", "fake", { excludeDocumentTypes: ["10"], requestPolicy: policy }), own: 2, hidden: 1 },
  ];
  try {
    for (const library of libraries) {
      const status: SyncStatus = { documents_indexed: library.own, documents_total: 10, chunks: 20, syncing: false, last_sync: null, last_error: null };
      await withServer(createServerFactory({ api: library.api, library: { name: library.name }, publicUrl: "http://p.test", scoped: true,
        search: Promise.resolve({} as SemanticSearch), indexStatus: () => status })(), async (client) => {
        const before = calls.length;
        await client.listResources();
        await client.listResourceTemplates();
        await client.listPrompts();
        const index = await client.readResource({ uri: "paperless://library/index-status" });
        const snapshot = parseResourceText(index);
        assert.equal(snapshot.library, library.name);
        assert.equal(snapshot.documents_indexed, library.own);
        assert.equal(snapshot.complete, false);
        assert.equal(calls.length, before, "discovery/status performs no requests");
        for (const suffix of ["metadata", "content?offset=2&max_chars=7", "notes?offset=3&limit=2", "download", "download?original=true", "thumb", "thumbnail"]) {
          const read = await client.readResource({ uri: `paperless://documents/${library.own}/${suffix}` });
          const value = String("text" in read.contents[0] ? read.contents[0].text : Buffer.from(read.contents[0].blob, "base64").toString());
          assert.ok(!value.includes(library.name === "research" ? "Household only" : "Research only"));
          const errorMessage = async (id: number) => {
            try { await client.readResource({ uri: `paperless://documents/${id}/${suffix}` }); assert.fail("must reject"); }
            catch (e) { return String(e).replaceAll(`Document ${id}`, "Document <id>"); }
          };
          assert.equal(await errorMessage(library.hidden), await errorMessage(999));
        }
        assert.ok(!calls.some((c) => new RegExp(`/documents/${library.hidden}/(notes|download|thumb)/`).test(c.path)), "hidden subresources never fetched");
        const text = await client.readResource({ uri: `paperless://documents/${library.own}/content` });
        const body = parseResourceText(text);
        assert.equal(body.content.length, 8000);
        assert.equal(body.next_offset, 8000);
        assert.equal(body.total_chars, 40_000);
        assert.match(body.web_url, /\/details$/);
        const notes = await client.readResource({ uri: `paperless://documents/${library.own}/notes?limit=50` });
        const n = parseResourceText(notes);
        assert.equal(n.notes.length, 50);
        assert.equal(n.notes[0].note.length, 2000);
        assert.equal(n.notes[0].truncated, true);
        assert.equal(n.next_offset, 50);
        assert.ok(!JSON.stringify(n).includes("not exposed"));
        const result = await client.callTool({ name: "list_document_notes", arguments: { id: library.own } });
        assert.deepEqual(result.structuredContent, { items: parseToolText(result) });
        const content = await client.callTool({ name: "get_document_content", arguments: { id: library.own, offset: 2, max_chars: 3 } });
        assert.deepEqual(content.structuredContent, parseToolText(content));
        const start = calls.length;
        for (const uri of [
          "paperless://documents/0/metadata", "paperless://documents/1.5/content", "paperless://documents/9007199254740993/notes",
          "paperless://documents/1/content?offset=-1", "paperless://documents/1/content?max_chars=32001", "paperless://documents/1/content?offset=1&offset=2",
          "paperless://documents/1/metadata?scope=all", "paperless://documents/1/notes?limit=51", "paperless://documents/1/download?original=perhaps",
          "paperless://documents/1/content#fragment", "paperless://user@documents/1/content", "paperless://documents/1/notes?offset=NaN",
        ]) await assert.rejects(client.readResource({ uri }), uri);
        assert.equal(calls.length, start, "invalid URI rejected before I/O");
      });
      // Calls from the previous library must not affect this assertion's paths.
      calls.length = 0;
    }
  } finally { globalThis.fetch = realFetch; }
});

test("disabled, loading and failed index status never waits for or starts search", async () => {
  for (const expected of ["disabled", "loading", "unavailable"] as const) {
    const search = expected === "disabled" ? undefined : expected === "loading" ? new Promise<SemanticSearch>(() => {}) : Promise.reject(new Error("private upstream detail"));
    await withServer(createServerFactory({ api: new PaperlessAPI("http://p.test", "fake"), publicUrl: "http://p.test", search })(), async (client) => {
      const result = await client.readResource({ uri: "paperless://library/index-status" });
      assert.equal(parseResourceText(result).state, expected);
      assert.ok(!JSON.stringify(result).includes("private upstream detail"));
    });
  }
});
