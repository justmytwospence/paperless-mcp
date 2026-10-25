# paperless-mcp-server

An MCP server for [Paperless-ngx](https://docs.paperless-ngx.com/) built for agents
that read and file a document library: find documents by meaning or by keyword, read
them (in slices, for long books), add papers from the web or files they hold, and
annotate them with notes.

## Tools

| | |
|---|---|
| Find | `semantic_search` (by meaning, with matching passages), `query_documents` (full text and structured filters), `list_documents` |
| Read | `get_document`, `get_document_content` (`offset`/`max_chars`), `download_document`, `get_document_thumbnail`, plus `paperless://documents/{id}/download` and `/thumb` resources |
| File | `post_document_from_url`, `post_document_from_file`, `get_task_status` |
| Edit | `update_document`, `bulk_edit_documents` |
| Notes | `list_document_notes`, `create_document_note`, `delete_document_note` |
| Taxonomy | `list_tags`, `create_tag`, `update_tag`, `list_correspondents`, `create_correspondent`, `list_document_types`, `create_document_type`, `list_custom_fields` |

Nothing here deletes a document, tag, correspondent or document type.

## Semantic search

With `PAPERLESS_MCP_DATA_DIR` set, the server keeps a vector index of the library in
`<dir>/index.db`:

- **What is indexed:** each document's full content, split into overlapping chunks of
  about 480 tokens with no cap per document, plus one metadata chunk (title,
  correspondent, type, tags, date, custom fields) that also carries the document's
  notes.
- **Model:** `Xenova/bge-small-en-v1.5`, run locally on the CPU through ONNX. It is
  downloaded once into `<dir>/models`; no API key, and no document text leaves the
  host.
- **Sync:** a background loop reads only what changed since the last pass, every
  `PAPERLESS_MCP_SYNC_INTERVAL_MINUTES`. An hourly reconcile pass removes deleted
  documents and picks up new notes, which do not change a document's modified time.
  Content is re-embedded only when its text changes, so retagging a book costs one
  small chunk.
- **Query:** `semantic_search` ranks chunks by cosine similarity and fuses the result
  with Paperless's keyword search by reciprocal rank fusion (`hybrid`, on by
  default). Filters (tags, correspondent, type, dates) are evaluated by Paperless
  first. Each result carries its best passages with character offsets for
  `get_document_content`, and every response reports index coverage (`index`).

The first build takes a while (roughly an hour per 50,000 chunks on one core); search
works throughout and says how much is covered. The index can always be rebuilt from
Paperless: delete it and it starts over. It also starts over by itself when the model
changes.

## Configuration

| Variable | Default | |
|---|---|---|
| `PAPERLESS_URL` | required | API base, e.g. `http://paperless:8000` |
| `PAPERLESS_API_KEY` | required | API token; the server acts as this user |
| `PAPERLESS_PUBLIC_URL` | `PAPERLESS_URL` | Browser URL used in `web_url` links |
| `PAPERLESS_API_VERSION` | `9` | REST API version sent in `Accept` |
| `MCP_TRANSPORT` | `stdio` | `http` for Streamable HTTP (the image default) |
| `PORT` | `8000` | HTTP port; `/mcp` and `/health` |
| `MCP_ALLOWED_HOSTS` | any | Host header allowlist (DNS-rebinding protection) |
| `PAPERLESS_MCP_LIBRARIES` | unset | Several libraries: a JSON file path or inline JSON (see Libraries) |
| `PAPERLESS_MCP_DOCUMENT_TYPES` / `_EXCLUDE_DOCUMENT_TYPES` / `_UPLOAD_DOCUMENT_TYPE` | unset | The single library's scope (see Libraries) |
| `PAPERLESS_MCP_DATA_DIR` | unset (`/data` in the image) | Enables semantic search |
| `PAPERLESS_MCP_SYNC_INTERVAL_MINUTES` | `10` | Incremental sync interval |
| `PAPERLESS_MCP_RECONCILE_INTERVAL_MINUTES` | `60` | Full reconcile interval |
| `PAPERLESS_MCP_EMBED_THREADS` | `1` | ONNX intra-op threads |
| `PAPERLESS_MCP_CHUNK_TOKENS` / `_CHUNK_OVERLAP_TOKENS` | `480` / `64` | Chunk size; changing it applies to documents as they are re-indexed |
| `PAPERLESS_MCP_UPLOAD_ROOT` | unset | Single library: enables `post_document_from_file`, a folder with one `agent-<name>/` subfolder per agent |
| `PAPERLESS_MCP_MAX_FILE_BYTES` | 100 MB | Upload size cap |

### Libraries

A library is one MCP endpoint over part of Paperless, chosen by document type. Agents
connected to a library see only its documents: searches, lists, reads, notes, edits
and downloads are confined to it, a document outside it answers exactly like one that
does not exist, edits cannot move a document out of it, uploads are filed into it, and
its semantic index holds only its documents. Tags, correspondents and custom fields
are shared by Paperless and stay visible.

For one library, use environment variables: `PAPERLESS_MCP_DOCUMENT_TYPES=Invoice,Receipt`
(only these), or `PAPERLESS_MCP_EXCLUDE_DOCUMENT_TYPES=Invoice` (everything else,
untyped documents included), and optionally `PAPERLESS_MCP_UPLOAD_DOCUMENT_TYPE` for
uploads that name no type (default: the only included type, if there is one). It is
served at `/mcp`. With neither set, the server sees all of Paperless.

For several, point `PAPERLESS_MCP_LIBRARIES` at a JSON file (or give the JSON inline).
One process then serves each library at `/<name>/mcp`, with one copy of the model:

```json
{
  "libraries": [
    {
      "name": "research",
      "description": "academic papers and preprints",
      "document_types": ["Paper"],
      "upload_root": "/uploads/research"
    },
    {
      "name": "household",
      "description": "bills, contracts and other household paperwork",
      "exclude_document_types": ["Paper"],
      "upload_document_type": "Paperwork",
      "upload_root": "/uploads/household",
      "semantic_search": true
    }
  ]
}
```

| Field | | |
|---|---|---|
| `name` | required | URL segment, lowercase letters, digits, dashes |
| `description` | | One line agents read in the server instructions |
| `document_types` / `exclude_document_types` | one or neither | Names or ids |
| `upload_document_type` | | Type for uploads that name none |
| `upload_root` | | Enables `post_document_from_file` for this library |
| `semantic_search` | `true` | Index in `PAPERLESS_MCP_DATA_DIR/<name>` (needs a data dir) |

Over stdio, the server serves one library: `PAPERLESS_MCP_LIBRARY`, or the first.

The HTTP transport does not authenticate requests. Run it behind a proxy that does,
on a network only that proxy can reach.

```sh
docker run -e PAPERLESS_URL=http://paperless:8000 -e PAPERLESS_API_KEY=... \
  -v ./mcp-index:/data -p 8000:8000 ghcr.io/justmytwospence/paperless-mcp:3
```

## Development

```sh
npm ci --ignore-scripts
npm test                               # unit tests (fake embedder, in-memory Paperless)
PAPERLESS_MCP_MODEL_TESTS=1 npm test   # plus a real-model smoke test
npm run typecheck && npm run build
```

Pushing a `vX.Y.Z` tag publishes `ghcr.io/justmytwospence/paperless-mcp:X.Y.Z`, `:X.Y`
and `:X`.

## Origin and credits

This began as a fork of [baruchiro/paperless-mcp](https://github.com/baruchiro/paperless-mcp)
(ISC), whose document, note, query and custom-field handling it still builds on, and
became its own project at 3.0.0. The semantic search design takes ideas from
[OrellBuehler/paperless-mcp](https://github.com/OrellBuehler/paperless-mcp) (sqlite-vec,
hash-gated re-embedding) and [hensing/searchless-ngx](https://github.com/hensing/searchless-ngx)
(chunked retrieval, watermark sync, metadata filters with vector ranking); no code was
copied from either.
