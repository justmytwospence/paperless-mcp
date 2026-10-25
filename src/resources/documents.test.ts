import assert from "node:assert/strict";
import { test } from "node:test";
import type { Client } from "@modelcontextprotocol/client";
import type { BinaryResponse, PaperlessAPI } from "../api/PaperlessAPI.js";
import { withClient } from "../test/mcp.js";
import { createDocument } from "../test/mocks/paperlessApi.js";
import { registerDocumentResources } from "./documents.js";

function emptyPaginationResponse<T>(results: T[] = [], all: number[] = []) {
  return {
    count: results.length,
    next: null,
    previous: null,
    all,
    results,
  };
}

function createBinaryResponse(body: string, contentType: string): BinaryResponse {
  return { data: Buffer.from(body), contentType };
}

function withResourceClient(api: PaperlessAPI, run: (client: Client) => Promise<void>) {
  return withClient((server) => registerDocumentResources(server, api), run);
}

test("resources/list does not enumerate documents at startup", async () => {
  // Documents are dynamic DMS data and must not be pre-registered as MCP
  // resources: enumerating them floods `resources/list` and the LLM context
  // window (issue #112). The list must stay empty even when documents exist;
  // documents are reached on demand via tools + the `resources/read` template.
  const api = {
    getDocuments: async () =>
      emptyPaginationResponse(
        [
          createDocument({
            id: 1,
            title: "Invoice",
            mime_type: "application/pdf",
          }),
          createDocument({
            id: 2,
            title: "Receipt",
            mime_type: "image/png",
          }),
        ],
        [1, 2, 3]
      ),
  } as unknown as PaperlessAPI;

  await withResourceClient(api, async (client) => {
    const result = await client.listResources();

    assert.deepEqual(result.resources, []);
  });
});

test("resources/read returns text contents for text responses", async () => {
  const api = {
    getDocuments: async () => emptyPaginationResponse(),
    downloadDocument: async () =>
      createBinaryResponse("plain text", "text/plain; charset=utf-8"),
  } as unknown as PaperlessAPI;

  await withResourceClient(api, async (client) => {
    const result = await client.readResource({
      uri: "paperless://documents/4/download",
    });

    assert.deepEqual(result.contents, [
      {
        uri: "paperless://documents/4/download",
        mimeType: "text/plain; charset=utf-8",
        text: "plain text",
      },
    ]);
  });
});
