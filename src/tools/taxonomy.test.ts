import assert from "node:assert/strict";
import { test } from "node:test";
import { parseToolText, withClient } from "../test/mcp.js";
import { registerTaxonomyTools } from "./taxonomy.js";

const TAGS = [1, 2, 3, 4, 5].map((id) => ({ id, name: `t${id}`, matching_algorithm: 0, document_count: id }));

function api(scoped: boolean) {
  const queries: string[] = [];
  const page = (results: any[]) => ({ count: results.length, next: null, previous: null, all: results.map((r) => r.id), results });
  return {
    queries,
    api: {
      scope: async () => (scoped ? { include: [1], exclude: null, uploadType: 1 } : null),
      // The library may see the odd ids, and uses each once.
      scopeTaxonomy: async (_kind: string, items: any[]) =>
        items.filter((t) => t.id % 2).map((t) => ({ ...t, document_count: 1 })),
      getTags: async (q?: string) => (queries.push(q ?? ""), page(TAGS)),
      getDocumentTypes: async () => page([{ id: 1, name: "Academic" }, { id: 6, name: "Paperwork" }]),
    } as any,
  };
}

test("a scoped list is filtered, recounted and paged by the server", async () => {
  const { api: a, queries } = api(true);
  await withClient(
    (s) => registerTaxonomyTools(s, a, { scoped: true }),
    async (client) => {
      const first = parseToolText(await client.callTool({ name: "list_tags", arguments: { page_size: 2, name__icontains: "t" } }));
      assert.deepEqual(
        { count: first.count, all: first.all, ids: first.results.map((t: any) => t.id), next: first.next },
        { count: 3, all: [1, 3, 5], ids: [1, 3], next: 2 }
      );
      assert.ok(first.results.every((t: any) => t.document_count === 1));
      const second = parseToolText(await client.callTool({ name: "list_tags", arguments: { page: 2, page_size: 2 } }));
      assert.deepEqual([second.results.map((t: any) => t.id), second.next, second.previous], [[5], null, 1]);
      const types = parseToolText(await client.callTool({ name: "list_document_types", arguments: {} }));
      assert.deepEqual([types.count, types.all], [1, [1]]);
    }
  );
  // Filters reach Paperless; paging does not (the server pages the filtered list).
  assert.match(queries[0], /name__icontains=t/);
  assert.doesNotMatch(queries[0], /page=/);
});

test("an unscoped list is Paperless's own answer", async () => {
  const { api: a, queries } = api(false);
  await withClient(
    (s) => registerTaxonomyTools(s, a),
    async (client) => {
      const res = parseToolText(await client.callTool({ name: "list_tags", arguments: { page: 1, page_size: 2 } }));
      assert.equal(res.count, 5);
    }
  );
  assert.match(queries[0], /page_size=2/);
});
