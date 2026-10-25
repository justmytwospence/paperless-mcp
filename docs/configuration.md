# Configuration

Everything is set through environment variables; several libraries are defined in one
JSON document.

## Connection

| Variable | Default | |
|---|---|---|
| `PAPERLESS_URL` | required | Paperless base URL the server calls, e.g. `http://paperless:8000` |
| `PAPERLESS_API_KEY` | required | API token. The server acts as this user: it sees what the user sees, and uploads are owned by them |
| `PAPERLESS_PUBLIC_URL` | `PAPERLESS_URL` | The URL a browser uses, for the `web_url` links in results (useful when `PAPERLESS_URL` is an internal Docker name) |
| `PAPERLESS_API_VERSION` | `9` | REST API version sent in `Accept`. 9 works with Paperless-ngx 2.x and 3.x |

## Transport

| Variable | Default | |
|---|---|---|
| `MCP_TRANSPORT` | `stdio` (`http` in the image) | `stdio` for clients that launch the server; `http` for Streamable HTTP |
| `PORT` | `8000` | HTTP port |
| `MCP_ALLOWED_HOSTS` | any | Comma-separated Host header values to accept (DNS-rebinding protection), e.g. `paperless-mcp,mcp.example.com` |
| `PAPERLESS_MCP_LIBRARY` | first library | Over stdio, which library to serve |

HTTP endpoints: `/mcp` (the single-library setup), `/<name>/mcp` (each named library),
and `/health`:

```json
{ "status": "ok", "name": "paperless-mcp-server", "version": "3.2.2",
  "libraries": { "default": { "index": { "documents_indexed": 812, "documents_total": 1027,
    "chunks": 61420, "syncing": true, "last_sync": "...", "last_error": null } } } }
```

## Semantic search

| Variable | Default | |
|---|---|---|
| `PAPERLESS_MCP_DATA_DIR` | unset (`/data` in the image) | Enables semantic search; the index lives here (`index.db`, or `<name>/index.db` per library) |
| `PAPERLESS_MCP_MODEL_DIR` | unset (`/app/models` in the image) | A directory holding the model files; when set, nothing is downloaded. Unset: downloaded into `<data dir>/models` on first use |
| `PAPERLESS_MCP_EMBEDDING_MODEL` | `Xenova/bge-small-en-v1.5` | Any transformers.js feature-extraction model. Changing it rebuilds the index |
| `PAPERLESS_MCP_EMBED_THREADS` | `1` | CPU threads for embedding. Most of the first build's time; 4 is about 2.3x faster than 1 |
| `PAPERLESS_MCP_CHUNK_TOKENS` | `480` | Chunk size in model tokens (bge's window is 512) |
| `PAPERLESS_MCP_CHUNK_OVERLAP_TOKENS` | `64` | Overlap between consecutive chunks |
| `PAPERLESS_MCP_SYNC_INTERVAL_MINUTES` | `10` | How often changed documents are re-read |
| `PAPERLESS_MCP_RECONCILE_INTERVAL_MINUTES` | `60` | How often every document is re-checked (deletions, new notes) |

Chunk size changes apply to documents as they are next re-indexed; to apply one to the
whole library, delete the index.

## Uploads

| Variable | Default | |
|---|---|---|
| `PAPERLESS_MCP_UPLOAD_ROOT` | unset | Enables `post_document_from_file` (single library; libraries set `upload_root`) |
| `PAPERLESS_MCP_MAX_FILE_BYTES` | 100 MB | Largest file accepted by either upload tool |

The upload root holds one folder per agent, named `agent-<name>` (lowercase letters,
digits, dashes). Mount it read-only into the server, and each agent's own folder
read-write into that agent only. An agent saves a file into its folder and calls
`post_document_from_file` with `agent-<name>/<file>`; the document is tagged
`agent-<name>`, so everything an agent filed stays reviewable. Paths that leave the agent
folder, symlinks out of the root, empty files and oversized files are refused.

## Libraries

A library is one MCP endpoint over part of Paperless, chosen by document type:

- every list, search (keyword and semantic), read, note, download and edit is confined to
  it, and a document outside it answers exactly like one that does not exist;
- edits cannot give a document a type outside the library;
- uploads are filed into it (with its upload type, see below);
- its semantic index holds only its documents;
- `list_document_types` shows only its types, and `create_document_type` is not offered.

Tags, correspondents and custom fields are shared across Paperless and stay visible in
every library.

### One library

| Variable | |
|---|---|
| `PAPERLESS_MCP_DOCUMENT_TYPES` | Only these types (comma-separated names or ids) |
| `PAPERLESS_MCP_EXCLUDE_DOCUMENT_TYPES` | Everything except these types, untyped documents included |
| `PAPERLESS_MCP_UPLOAD_DOCUMENT_TYPE` | Type for uploads that do not name one. Default: the only included type, if exactly one is included; otherwise none |

With neither of the first two, the server sees all of Paperless. Served at `/mcp`.

### Several libraries

Set `PAPERLESS_MCP_LIBRARIES` to a JSON file path, or to the JSON itself (anything
starting with `{`):

```json
{
  "libraries": [
    {
      "name": "research",
      "description": "academic papers, preprints and textbooks",
      "document_types": ["Paper", "Book"],
      "upload_document_type": "Paper",
      "upload_root": "/uploads/research"
    },
    {
      "name": "household",
      "description": "bills, contracts, tax forms and other paperwork",
      "exclude_document_types": ["Paper", "Book"],
      "upload_root": "/uploads/household",
      "semantic_search": true
    }
  ]
}
```

| Field | | |
|---|---|---|
| `name` | required | Endpoint `/<name>/mcp`; lowercase letters, digits, dashes; unique |
| `description` | | One line agents read in the server's instructions |
| `document_types` | one of these, or neither | Names or ids to include |
| `exclude_document_types` | | Names or ids to exclude (untyped documents are included) |
| `upload_document_type` | | Type for uploads that do not name one |
| `upload_root` | | Enables `post_document_from_file` for this library |
| `semantic_search` | `true` | Index in `<data dir>/<name>/index.db` (needs `PAPERLESS_MCP_DATA_DIR`) |

Unknown fields are refused, so a typo fails loudly at startup. A type name that does not
exist in Paperless is reported in the log, and that library answers every call with an
error until it does.

To keep two libraries from ever overlapping or leaving documents out, define one by
inclusion and the other by exclusion of the same types, as above.
