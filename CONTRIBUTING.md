# Contributing

Issues and pull requests are welcome. For anything beyond a small fix, open an issue
first so we can agree on the shape before you spend time on it.

## Setup

```sh
npm ci --ignore-scripts      # onnxruntime's install script only fetches GPU builds; not needed
npm test                     # fast: fake embedder, in-memory Paperless, stub fetch
npm run typecheck            # sources and tests
PAPERLESS_MCP_MODEL_TESTS=1 npm test   # also loads the real model (downloads ~130 MB once)
```

Try it against a real Paperless over stdio with the MCP Inspector:

```sh
npm run build
PAPERLESS_URL=... PAPERLESS_API_KEY=... npx @modelcontextprotocol/inspector node dist/index.js
```

## Layout

| Path | |
|---|---|
| `src/api/PaperlessAPI.ts` | The only code that calls Paperless, and where library scopes are enforced |
| `src/tools/` | One file per tool group; `utils/register.ts` wraps registration and annotations |
| `src/search/` | Chunking, embedding, the sqlite-vec store, sync, and query fusion |
| `src/libraries.ts` | Library definitions; `src/index.ts` wires libraries to endpoints |
| `src/test/` | Fakes shared by the tests |

## What a change should keep true

- **No tool deletes documents, tags, correspondents or document types**, and nothing in
  the server calls an LLM. The tool list is pinned by `src/server.test.ts`; changing it is
  a deliberate decision, not a side effect.
- **Every document path goes through `PaperlessAPI`'s scoped methods.** `request()`
  refuses `/documents` paths so a new tool cannot bypass a library by accident.
- **Schemas stay client-compatible.** `src/tools/schemaCompat.test.ts` fails on
  array-form JSON Schema `type`s, which strict clients reject; describe each member of a
  zod union of primitives.
- **Nothing is specific to one installation.** Type names, library names and paths come
  from configuration.
- Tests for behaviour, a `CHANGELOG.md` entry for anything user-visible, and
  [conventional commits](https://www.conventionalcommits.org/).

## Releases

Maintainers bump `package.json`, add the changelog entry, and push a `vX.Y.Z` tag; the
release workflow publishes the multi-arch image to GHCR.
