# paperless-mcp-server: agent notes

An MCP server for Paperless-ngx, on the MCP TypeScript SDK v2 (`@modelcontextprotocol/server`,
served with `createMcpHandler` and Hono), ESM, Node 24. Layout follows our other MCP servers
(hardcover-mcp): `src/index.ts` picks a transport, `src/server.ts` builds servers from a shared
context, and each `src/tools/*.ts` registers its tools.

## Layout

- `src/api/PaperlessAPI.ts`: the only code that talks to Paperless (fetch). It also
  enforces a library's document-type scope (include or exclude): every document path
  goes through its scoped methods, and `request()` refuses `/documents` paths.
- `src/libraries.ts`: library definitions (`PAPERLESS_MCP_LIBRARIES`, or one "default"
  library from the env vars). `src/index.ts` builds one PaperlessAPI, server factory and
  index per library, sharing the embedder, and routes `/<name>/mcp`. Taxonomy getters
  without a query string return everything and are cached for 60 s.
- `src/tools/`: tool registration through `tools/utils/register.ts` (`registerTool`, with
  `READ_ONLY`/`WRITE`/`OPEN_WRITE`/`DESTRUCTIVE` annotations). `semanticSearch.ts` exists only
  when the index is enabled.
- `src/search/`: `chunk.ts` (token-budgeted, sentence-aware, no per-document cap), `embed.ts`
  (transformers.js, bge query prefix, CLS pooling), `store.ts` (node:sqlite + sqlite-vec),
  `sync.ts` (reconcile and incremental passes, hash-gated re-embedding), `search.ts` (vector +
  keyword reciprocal rank fusion).

## Rules

- Nothing here may assume a particular Paperless: type names, library names and paths
  come from configuration, never from code or defaults.
- The tool surface is deliberate: no tool deletes documents or taxonomy. Adding a tool means
  adding it to the list in `src/server.test.ts`.
- Tool results hand back source material; nothing in this server calls an LLM.
- Every advertised schema must pass `src/tools/schemaCompat.test.ts`: a zod union of bare
  primitives becomes an array-form `type`, which strict clients reject. Describe each member.
- The index holds nothing that cannot be rebuilt from Paperless. Bump `SCHEMA_VERSION` in
  `store.ts` for an incompatible schema change; it then rebuilds itself.
- Run `npm run typecheck && npm test` before committing. Conventional commits.
- Release: bump `package.json`, add a `CHANGELOG.md` entry, tag `vX.Y.Z`, push the tag.

## Documentation

User docs live in `README.md` (pitch and quick start) and `docs/` (configuration,
deployment and security, semantic search, tools). A change to behaviour, a setting or a
tool updates the matching page in the same commit. Keep examples generic: no hostnames,
type names or agents from any one installation.
