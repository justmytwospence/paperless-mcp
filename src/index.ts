#!/usr/bin/env node

// Entry point: serve the MCP server over stdio (default) or Streamable HTTP
// (MCP_TRANSPORT=http), and, when PAPERLESS_MCP_DATA_DIR is set, keep the semantic
// search index in step with Paperless in the background.

import path from "node:path";
import { serve } from "@hono/node-server";
import { createMcpHonoApp } from "@modelcontextprotocol/hono";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { Context } from "hono";
import { setPublicUrl } from "./api/documentLinks.js";
import { PaperlessAPI } from "./api/PaperlessAPI.js";
import * as config from "./config.js";
import { loadEmbedder } from "./search/embed.js";
import { SemanticSearch } from "./search/search.js";
import { VectorStore } from "./search/store.js";
import { Syncer } from "./search/sync.js";
import { createServerFactory, SERVER_NAME, VERSION } from "./server.js";

if (!config.PAPERLESS_URL || !config.PAPERLESS_API_KEY) {
  console.error("ERROR: PAPERLESS_URL and PAPERLESS_API_KEY environment variables are required.");
  process.exit(1);
}

setPublicUrl(config.PAPERLESS_PUBLIC_URL);
const api = new PaperlessAPI(config.PAPERLESS_URL, config.PAPERLESS_API_KEY);

let syncer: Syncer | undefined;
let search: Promise<SemanticSearch> | undefined;
if (config.DATA_DIR) {
  search = (async () => {
    const embedder = await loadEmbedder(
      config.EMBEDDING_MODEL,
      path.join(config.DATA_DIR, "models"),
      config.EMBED_THREADS,
      config.MODEL_DIR || undefined
    );
    const store = new VectorStore(path.join(config.DATA_DIR, "index.db"), embedder.model, embedder.dims);
    syncer = new Syncer(api, store, embedder, {
      chunkTokens: config.CHUNK_TOKENS,
      overlapTokens: config.CHUNK_OVERLAP_TOKENS,
    });
    syncer.start(config.SYNC_INTERVAL_MINUTES, config.RECONCILE_INTERVAL_MINUTES);
    const s = syncer;
    console.error(`semantic search: ${embedder.model} (${embedder.dims} dims), index ${config.DATA_DIR}`);
    return new SemanticSearch(api, store, embedder, () => s.getStatus());
  })();
  // A failed model load must not take the rest of the server down; the tool
  // reports the error instead.
  search.catch((err) => console.error("semantic search unavailable:", err));
}

const createServer = createServerFactory({ api, publicUrl: config.PAPERLESS_PUBLIC_URL, search });
const transport = (process.env.MCP_TRANSPORT ?? "stdio").toLowerCase();

if (transport === "stdio") {
  serveStdio(createServer);
  console.error(`${SERVER_NAME} ${VERSION} running via stdio`);
} else if (transport === "http") {
  const port = Number(process.env.PORT ?? 8000);
  // Hostnames clients may use in the Host header (DNS-rebinding protection). Unset
  // means any host, which is fine on a private network or behind a reverse proxy.
  const extraHosts = (process.env.MCP_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  const allowedHosts = extraHosts.length ? ["localhost", "127.0.0.1", ...extraHosts] : undefined;

  const handler = createMcpHandler(createServer);
  const app = createMcpHonoApp({ host: "0.0.0.0", allowedHosts });
  app.get("/health", (c) =>
    c.json({
      status: "ok",
      name: SERVER_NAME,
      version: VERSION,
      index: syncer ? syncer.getStatus() : null,
    })
  );
  const mcp = (c: Context) => handler.fetch(c.req.raw, { parsedBody: c.get("parsedBody") });
  app.all("/mcp", mcp);
  app.all("/", mcp);

  const httpServer = serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, (info) =>
    console.error(`${SERVER_NAME} ${VERSION} listening on http://0.0.0.0:${info.port}/mcp`)
  );
  const shutdown = async () => {
    syncer?.stop();
    await handler.close();
    httpServer.close(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
} else {
  console.error(`ERROR: MCP_TRANSPORT must be "stdio" or "http", got "${transport}".`);
  process.exit(1);
}
