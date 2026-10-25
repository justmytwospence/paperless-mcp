// Entry point: serve one or more libraries over stdio (default) or Streamable
// HTTP (MCP_TRANSPORT=http). Each library is a scoped view of Paperless with its
// own tools endpoint and, when it has a data directory, its own semantic index,
// kept in step with Paperless in the background. Libraries share one model.

import path from "node:path";
import { serve } from "@hono/node-server";
import { createMcpHonoApp } from "@modelcontextprotocol/hono";
import { createMcpHandler, type McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { Context } from "hono";
import { setPublicUrl } from "./api/documentLinks.js";
import { PaperlessAPI } from "./api/PaperlessAPI.js";
import * as config from "./config.js";
import { type Library, loadLibraries } from "./libraries.js";
import type { Embedder } from "./search/embed.js";
import { SemanticSearch } from "./search/search.js";
import { VectorStore } from "./search/store.js";
import { Syncer } from "./search/sync.js";
import { loadWorkerEmbedder } from "./search/worker.js";
import { createServerFactory, SERVER_NAME, VERSION } from "./server.js";

if (!config.PAPERLESS_URL || !config.PAPERLESS_API_KEY) {
  console.error("ERROR: PAPERLESS_URL and PAPERLESS_API_KEY environment variables are required.");
  process.exit(1);
}

setPublicUrl(config.PAPERLESS_PUBLIC_URL);

let libraries: Library[];
try {
  libraries = loadLibraries();
} catch (err) {
  console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

let embedder: Promise<Embedder> | undefined;
const sharedEmbedder = () =>
  (embedder ??= loadWorkerEmbedder({
    model: config.EMBEDDING_MODEL,
    cacheDir: path.join(config.DATA_DIR || "/tmp/paperless-mcp", "models"),
    threads: config.EMBED_THREADS,
    localModelDir: config.MODEL_DIR || undefined,
  }));

interface Served {
  library: Library;
  createServer: () => McpServer;
  syncer?: Syncer;
}

const served: Served[] = libraries.map((library) => {
  const api = new PaperlessAPI(config.PAPERLESS_URL, config.PAPERLESS_API_KEY, {
    documentTypes: library.documentTypes,
    excludeDocumentTypes: library.excludeDocumentTypes,
    uploadDocumentType: library.uploadDocumentType,
  });
  const scoped = library.documentTypes.length > 0 || library.excludeDocumentTypes.length > 0;
  const entry: Served = { library, createServer: () => null as never };
  if (scoped) {
    api
      .scope()
      .then((scope) => console.error(`library ${library.name}: scope ${JSON.stringify(scope)}`))
      .catch((err) => console.error(`library ${library.name}: scope error: ${err.message}`));
  }

  let search: Promise<SemanticSearch> | undefined;
  if (library.dataDir) {
    const dataDir = library.dataDir;
    search = (async () => {
      const e = await sharedEmbedder();
      const store = new VectorStore(path.join(dataDir, "index.db"), e.model, e.dims);
      const syncer = new Syncer(api, store, e, {
        chunkTokens: config.CHUNK_TOKENS,
        overlapTokens: config.CHUNK_OVERLAP_TOKENS,
        log: (m) => console.error(`[${library.name}] ${m}`),
      });
      entry.syncer = syncer;
      syncer.start(config.SYNC_INTERVAL_MINUTES, config.RECONCILE_INTERVAL_MINUTES);
      console.error(`library ${library.name}: semantic search (${e.model}), index ${dataDir}`);
      return new SemanticSearch(api, store, e, () => syncer.getStatus());
    })();
    // A failed model load must not take the rest of the server down; the tool
    // reports the error instead.
    search.catch((err) => console.error(`library ${library.name}: semantic search unavailable:`, err));
  }

  entry.createServer = createServerFactory({
    api,
    publicUrl: config.PAPERLESS_PUBLIC_URL,
    search,
    scoped,
    library: { name: library.name, description: library.description },
    uploadRoot: library.uploadRoot,
  });
  return entry;
});

const transport = (process.env.MCP_TRANSPORT ?? "stdio").toLowerCase();

if (transport === "stdio") {
  // stdio serves one library: PAPERLESS_MCP_LIBRARY, or the first.
  const wanted = process.env.PAPERLESS_MCP_LIBRARY;
  const one = wanted ? served.find((s) => s.library.name === wanted) : served[0];
  if (!one) {
    console.error(`ERROR: no library "${wanted}" (have: ${served.map((s) => s.library.name).join(", ")})`);
    process.exit(1);
  }
  serveStdio(one.createServer);
  console.error(`${SERVER_NAME} ${VERSION} running via stdio (library ${one.library.name})`);
} else if (transport === "http") {
  const port = Number(process.env.PORT ?? 8000);
  // Hostnames clients may use in the Host header (DNS-rebinding protection). Unset
  // means any host, which is fine on a private network or behind a reverse proxy.
  const extraHosts = (process.env.MCP_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  const allowedHosts = extraHosts.length ? ["localhost", "127.0.0.1", ...extraHosts] : undefined;

  const app = createMcpHonoApp({ host: "0.0.0.0", allowedHosts });
  app.get("/health", (c) =>
    c.json({
      status: "ok",
      name: SERVER_NAME,
      version: VERSION,
      libraries: Object.fromEntries(
        served.map((s) => [s.library.name, { index: s.syncer ? s.syncer.getStatus() : null }])
      ),
    })
  );
  const handlers = served.map((s) => {
    const handler = createMcpHandler(s.createServer);
    const mcp = (c: Context) => handler.fetch(c.req.raw, { parsedBody: c.get("parsedBody") });
    // The single-library setup keeps the plain endpoint; named libraries get their own.
    if (s.library.name === "default") {
      app.all("/mcp", mcp);
      app.all("/", mcp);
    } else {
      app.all(`/${s.library.name}/mcp`, mcp);
    }
    return handler;
  });

  const httpServer = serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, (info) =>
    console.error(
      `${SERVER_NAME} ${VERSION} listening on port ${info.port}: ` +
        served.map((s) => (s.library.name === "default" ? "/mcp" : `/${s.library.name}/mcp`)).join(", ")
    )
  );
  const shutdown = async () => {
    for (const s of served) s.syncer?.stop();
    await Promise.all(handlers.map((h) => h.close()));
    await embedder?.then((e) => e.close?.()).catch(() => undefined);
    httpServer.close(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
} else {
  console.error(`ERROR: MCP_TRANSPORT must be "stdio" or "http", got "${transport}".`);
  process.exit(1);
}
