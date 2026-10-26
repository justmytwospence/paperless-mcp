import assert from "node:assert/strict";
import { test } from "node:test";
import { PaperlessAPI } from "./api/PaperlessAPI.js";
import type { SemanticSearch } from "./search/search.js";
import { createServerFactory } from "./server.js";
import { parseResourceText } from "./test/mcp.js";
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

async function toolNames(search?: Promise<SemanticSearch>, scoped = false) {
  let names: string[] = [];
  await withServer(createServerFactory({ api, publicUrl: "http://p.test", search, scoped })(), async (client) => {
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

test("a scoped server cannot create document types", async () => {
  const names = await toolNames(undefined, true);
  assert.deepEqual(names, CORE.filter((n) => n !== "create_document_type"));
});

test("wire discovery has complete annotations, local resources, templates, prompts and library instructions without I/O", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Discovery must not fetch"); };
  const server = createServerFactory({
    api, publicUrl: "http://p.test", library: { name: "research", description: "Research sources" },
    search: new Promise<SemanticSearch>(() => {}), uploadRoot: "/never-opened",
  })();
  try {
    await withServer(server, async (client) => {
      const capabilities = client.getServerCapabilities()!;
      assert.ok(capabilities.tools && capabilities.resources && capabilities.prompts);
      assert.ok(!capabilities.resources.subscribe && !("sampling" in capabilities) && !("elicitation" in capabilities));
      assert.match(client.getInstructions()!, /library "research"/);
      assert.match(client.getInstructions()!, /REST quota \(unknown\)/);
      assert.match(client.getInstructions()!, /No write replay; the HTTP layer does not retry timeouts/);
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((t) => t.name).sort(), [...CORE, "post_document_from_file", "semantic_search"].sort());
      const reads = new Set(["download_document", "get_document", "get_document_content", "get_document_thumbnail", "get_task_status", "list_correspondents", "list_custom_fields", "list_document_notes", "list_document_types", "list_documents", "list_tags", "query_documents", "semantic_search"]);
      const local = new Set(["download_document", "get_document_thumbnail"]);
      const destructive = new Set(["update_document", "update_tag", "delete_document_note", "bulk_edit_documents"]);
      for (const tool of tools) {
        assert.ok(tool.title && tool.description, tool.name);
        assert.deepEqual(tool.annotations, {
          readOnlyHint: reads.has(tool.name), destructiveHint: destructive.has(tool.name),
          idempotentHint: reads.has(tool.name) || ["update_document", "update_tag", "delete_document_note"].includes(tool.name),
          openWorldHint: !local.has(tool.name),
        }, tool.name);
      }
      const { resources } = await client.listResources();
      assert.deepEqual(resources.map((r) => r.uri).sort(), ["info", "search", "index-status", "load-status"].map((s) => `paperless://library/${s}`).sort());
      for (const r of resources) {
        const response = await client.readResource({ uri: r.uri });
        assert.equal(response.contents[0].mimeType, "application/json");
      }
      const { resourceTemplates } = await client.listResourceTemplates();
      assert.deepEqual(resourceTemplates.map((r) => r.uriTemplate).sort(), [
        "paperless://documents/{id}/{resource}", "paperless://documents/{id}/download{?original}",
        "paperless://documents/{id}/metadata", "paperless://documents/{id}/content{?offset,max_chars}",
        "paperless://documents/{id}/notes{?offset,limit}",
      ].sort());
      const { prompts } = await client.listPrompts();
      assert.deepEqual(prompts.map((p) => p.name).sort(), ["cite_documents", "filing_review", "find_documents", "read_document"]);
      // Some clients expose only static resources and ignore template discovery/initialize instructions.
      const guide = parseResourceText(await client.readResource({ uri: "paperless://library/search" }));
      assert.deepEqual(guide.resource_templates.map((r: { uri_template: string }) => r.uri_template).sort(), resourceTemplates.map((r) => r.uriTemplate).sort());
      assert.deepEqual(guide.prompts.map((p: { name: string }) => p.name).sort(), prompts.map((p) => p.name).sort());
      assert.ok(guide.resource_templates.every((r: { example: string; cost: string }) => r.example && r.cost));
      assert.ok(guide.prompts.every((p: { arguments: unknown }) => p.arguments));
      assert.match(guide.prompt_cost, /zero-call/);
      for (const tool of tools) assert.match(tool.description!, /paperless:\/\/library\/load-status/, tool.name);
      for (const [name, args] of [
        ["find_documents", { query: "sources" }], ["read_document", { document_id: "1" }],
        ["cite_documents", { document_ids: "1,2", claim: "evidence" }],
        ["filing_review", { document_id: "1", proposed_changes: "rename" }],
      ] as const) {
        const prompt = await client.getPrompt({ name, arguments: args });
        assert.equal(prompt.messages[0].content.type, "text");
        assert.match(JSON.stringify(prompt), /research/);
        assert.match(JSON.stringify(prompt), /not an upstream quota/);
      }
      const uri = await client.callTool({ name: "download_document", arguments: { id: 4 } });
      assert.deepEqual(uri.structuredContent, { uri: "paperless://documents/4/download" });
      assert.equal(uri.content[0].type === "text" && uri.content[0].text, "paperless://documents/4/download");
      const invalid = await client.callTool({ name: "update_document", arguments: { id: -1 } });
      assert.equal(invalid.isError, true);
      await assert.rejects(client.getPrompt({ name: "read_document", arguments: { document_id: "../2" } }));
      await assert.rejects(client.readResource({ uri: "paperless://library/info?library=other" }));
      const status = await client.readResource({ uri: "paperless://library/load-status" });
      assert.equal(parseResourceText(status).attempts, 0);
    });
  } finally { globalThis.fetch = realFetch; }
});
