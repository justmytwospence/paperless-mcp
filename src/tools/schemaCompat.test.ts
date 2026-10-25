import assert from "node:assert/strict";
import { test } from "node:test";
import { PaperlessAPI } from "../api/PaperlessAPI.js";
import type { SemanticSearch } from "../search/search.js";
import { createServerFactory } from "../server.js";
import { withServer } from "../test/mcp.js";

// Strict MCP clients and gateways reject an array-valued `type` and silently drop
// the whole tool. zod's converter produces one whenever a union's members are all
// bare primitives (string | number | boolean), so this walks every advertised
// schema: any construct that reintroduces the form fails here.

function arrayFormTypes(node: unknown, path = ""): string[] {
  if (Array.isArray(node)) {
    return node.flatMap((item, i) => arrayFormTypes(item, `${path}[${i}]`));
  }
  if (!node || typeof node !== "object") {
    return [];
  }
  return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) =>
    key === "type" && Array.isArray(value)
      ? [`${path}.type = ${JSON.stringify(value)}`]
      : arrayFormTypes(value, `${path}.${key}`)
  );
}

test("no tool advertises an array-form `type` (#138)", async () => {
  const createServer = createServerFactory({
    api: new PaperlessAPI("http://paperless.test", "test-token"),
    publicUrl: "http://paperless.test",
    search: new Promise<SemanticSearch>(() => {}),
  });
  await withServer(createServer(), async (client) => {
    const { tools } = await client.listTools();
    const found = tools
      .flatMap((tool) => arrayFormTypes(tool.inputSchema).map((hit) => `${tool.name} ${hit}`))
      .sort();
    assert.deepEqual(found, []);
  });
});
