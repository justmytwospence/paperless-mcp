import assert from "node:assert/strict";
import { test } from "node:test";
import { PaperlessAPI } from "./api/PaperlessAPI.js";
import type { SemanticSearch } from "./search/search.js";
import { createServerFactory } from "./server.js";
import { withServer } from "./test/mcp.js";

const api = new PaperlessAPI("http://paperless.test", "test-token");

const CORE = [
  "bulk_edit_documents",
  "create_correspondent",
  "create_document_note",
  "create_document_type",
  "create_tag",
  "delete_document_note",
  "download_document",
  "get_document",
  "get_document_content",
  "get_document_thumbnail",
  "get_task_status",
  "list_correspondents",
  "list_custom_fields",
  "list_document_notes",
  "list_document_types",
  "list_documents",
  "list_tags",
  "post_document_from_url",
  "query_documents",
  "update_document",
  "update_tag",
];

async function toolNames(search?: Promise<SemanticSearch>) {
  let names: string[] = [];
  await withServer(createServerFactory({ api, publicUrl: "http://p.test", search })(), async (client) => {
    names = (await client.listTools()).tools.map((t) => t.name).sort();
  });
  return names;
}

test("the server offers exactly the curated tool set", async () => {
  assert.deepEqual(await toolNames(), CORE);
});

test("semantic_search is offered when the index is enabled", async () => {
  const names = await toolNames(new Promise<SemanticSearch>(() => {}));
  assert.deepEqual(names, [...CORE, "semantic_search"].sort());
});

test("nothing that deletes documents or taxonomy is offered", async () => {
  const names = await toolNames(new Promise<SemanticSearch>(() => {}));
  assert.deepEqual(
    names.filter((n) => n.startsWith("delete_")),
    ["delete_document_note"]
  );
});
