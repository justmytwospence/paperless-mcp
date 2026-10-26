import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/server";

/** Connects an in-memory client to a server set up by `register`, runs `run`, then closes both. */
export async function withClient(
  register: (server: McpServer) => void,
  run: (client: Client) => Promise<void>
): Promise<void> {
  const server = new McpServer({ name: "paperless-test", version: "0.0.0-test" });
  register(server);
  await withServer(server, run);
}

export async function withServer(
  server: McpServer,
  run: (client: Client) => Promise<void>
): Promise<void> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "paperless-test-client", version: "0.0.0-test" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

export function parseResourceText(result: ReadResourceResult) {
  const item = result.contents[0];
  if (!item || !("text" in item)) throw new Error("Expected text resource response");
  return JSON.parse(item.text);
}

export function parseToolText(result: unknown) {
  const item = (result as CallToolResult).content?.[0];
  if (!item || item.type !== "text") {
    throw new Error("Expected text tool response");
  }
  return JSON.parse(item.text);
}
