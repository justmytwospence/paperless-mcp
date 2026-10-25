# paperless-mcp-server

[![ci](https://github.com/justmytwospence/paperless-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/justmytwospence/paperless-mcp/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/tag/justmytwospence/paperless-mcp?label=image&sort=semver)](https://github.com/justmytwospence/paperless-mcp/pkgs/container/paperless-mcp)
[![license: ISC](https://img.shields.io/badge/license-ISC-blue)](LICENSE)

**Give your AI agents a library card for your [Paperless-ngx](https://docs.paperless-ngx.com/) archive.**

An [MCP](https://modelcontextprotocol.io/) server that lets Claude, Codex, Cursor or any MCP
client find documents in Paperless *by meaning*, read exactly the passage they need, file
new papers and files, and annotate what they read. Semantic search runs on your own
hardware: no API key, and no document text leaves the machine.

```text
You:    What have I saved about variational inference for hierarchical models?
Agent:  [semantic_search] Three documents cover it, with the passages that matched:
        - "Compositional Amortized Inference for Large-Scale Hierarchical
          Bayesian Models": "...amortized posterior over group-level ..."
          https://paperless.example.com/documents/1013/details
        - "Variational Inference: A Review for Statisticians": ...
```

## Why this one

- **Search that understands the question.** `semantic_search` finds the papers about a
  method even when they never use your words, and returns the matching *passages*, not
  just titles. It covers every page of every document, books included, and blends in
  Paperless's own keyword search so exact names still rank first.
- **Built for agents, not for admin.** Agents can add a paper from a URL or a file they
  hold, read a 900-page book in slices, leave notes, and cite documents with clickable
  links. They cannot delete documents, tags, correspondents or document types: those
  tools don't exist here.
- **Separate libraries from one Paperless.** Expose your research papers to one set of
  agents and your private paperwork to another, each as its own endpoint that cannot see
  the other's documents.
- **No LLM inside.** Every tool returns source material; the agent you already use does
  the reasoning. Nothing here spends tokens or sends your documents to a model provider.
- **Small and inspectable.** One container, one SQLite file per library, a pinned and
  checksummed embedding model inside the image, about 110 tests.

## Quick start

You need a Paperless-ngx instance and an API token (Paperless: *My Profile* > *API Auth
Token*). The server acts as that user and sees what that user sees.

**1. Run it.**

```sh
docker run -d --name paperless-mcp -p 127.0.0.1:8000:8000 \
  -e PAPERLESS_URL=https://paperless.example.com \
  -e PAPERLESS_API_KEY=your-token \
  -v paperless-mcp-data:/data \
  ghcr.io/justmytwospence/paperless-mcp:3
```

It starts indexing in the background straight away; `curl localhost:8000/health` shows
progress. Search works from the first minute and reports how much of the library it
covers.

**2. Connect a client.**

Claude Code:

```sh
claude mcp add --transport http paperless http://127.0.0.1:8000/mcp
```

Any client that takes a Streamable HTTP URL: `http://127.0.0.1:8000/mcp`.

Clients that launch servers over stdio (Claude Desktop and others) can run the same
image as a subprocess instead; see [Deployment](docs/deployment.md#stdio-clients).

**3. Ask.** Some things to try:

- "What do I have on causal inference with instrumental variables? Quote the key passages."
- "Find the warranty for the dishwasher and tell me when it expires."
- "Add https://arxiv.org/pdf/2006.11239 to Paperless and tag it diffusion."
- "Summarise chapter 4 of the Gelman book I saved." (read in slices with `get_document_content`)
- "Leave a note on that paper: compare with the zebrafish results."

> **The HTTP endpoint has no authentication.** Bind it to localhost (as above) or a
> private network, or put it behind a proxy that authenticates. See
> [Security](docs/deployment.md#security).

## How semantic search works

```text
Paperless ──(REST API)──> sync ──> chunk (~480 tokens, sentence-aware, every page)
                                   └─> embed (bge-small-en-v1.5, ONNX on CPU)
                                        └─> SQLite + sqlite-vec  (<data>/index.db)

semantic_search("...") ──> embed query ──> nearest chunks ──┐
                       └─> Paperless keyword search ────────┴─> fuse ranks ──> documents + passages
```

- The index covers each document's full text plus a metadata chunk (title, correspondent,
  type, tags, custom fields, and your notes), so a note you left is searchable too.
- A background sync re-reads only what changed, every 10 minutes, and re-embeds only text
  that actually changed: retagging a book costs one small chunk, not the whole book.
- Filters (tags, correspondent, type, dates) are applied by Paperless, so permissions and
  filter semantics are exactly Paperless's own.
- The first build is the slow part: about 7,000 chunks an hour on one CPU thread and
  17,000 on four (a page of text is roughly one chunk). Details, sizing and tuning: [Semantic search](docs/semantic-search.md).

## Libraries

By default the server exposes all of Paperless at `/mcp`. To split it, define libraries by
document type; each gets its own endpoint, upload folder and index, served by one process
that shares one copy of the model:

```json
{
  "libraries": [
    { "name": "research", "document_types": ["Paper", "Book"] },
    { "name": "household", "exclude_document_types": ["Paper", "Book"] }
  ]
}
```

`/research/mcp` then cannot see a single household document, and the reverse: an
out-of-library document answers exactly like one that does not exist, edits cannot move a
document across, and uploads land in the library they were made through. A single
library can also be set with environment variables. See
[Configuration](docs/configuration.md#libraries).

## Tools

| | |
|---|---|
| Find | `semantic_search`, `query_documents` (full-text query language, structured and custom-field filters, more-like-this), `list_documents` |
| Read | `get_document`, `get_document_content` (with `offset`/`max_chars`), `download_document`, `get_document_thumbnail` |
| File | `post_document_from_url`, `post_document_from_file`, `get_task_status` |
| Edit | `update_document`, `bulk_edit_documents` |
| Notes | `list_document_notes`, `create_document_note`, `delete_document_note` |
| Taxonomy | `list_tags`, `create_tag`, `update_tag`, `list_correspondents`, `create_correspondent`, `list_document_types`, `create_document_type`, `list_custom_fields` |

Every tool carries MCP annotations (read-only, destructive), so clients can auto-approve
reads and ask before writes. Arguments and behaviour: [Tools](docs/tools.md).

## Documentation

- [Configuration](docs/configuration.md): every setting, and libraries
- [Deployment](docs/deployment.md): Docker Compose, stdio clients, putting it behind auth
- [Semantic search](docs/semantic-search.md): indexing, sizing, coverage, privacy
- [Tools](docs/tools.md): the full tool reference
- [Changelog](CHANGELOG.md)

## Compared with other Paperless MCP servers

There are several good ones; this is how this one differs, so you can pick:

- [baruchiro/paperless-mcp](https://github.com/baruchiro/paperless-mcp), where this
  project started, covers much more of the Paperless admin API (mail rules, deletion,
  base64 upload) and has no semantic search. Pick it to *administer* Paperless.
- [OrellBuehler/paperless-mcp](https://github.com/OrellBuehler/paperless-mcp) exposes
  115+ tools including users and workflows, with optional semantic search that embeds
  the first part of each document through OpenAI or Ollama.
- [hensing/searchless-ngx](https://github.com/hensing/searchless-ngx) is a read-only,
  Python, ChromaDB-based semantic search server tuned for Open WebUI.

This one is for agents that *use* a library: local full-text semantic search with
passages, safe writes only, and separate libraries per audience.

## Development

```sh
npm ci --ignore-scripts
npm test                               # unit tests: fake embedder, in-memory Paperless
PAPERLESS_MCP_MODEL_TESTS=1 npm test   # plus a smoke test against the real model
npm run typecheck && npm run build
PAPERLESS_URL=... PAPERLESS_API_KEY=... npm run dev   # stdio, from source
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Releases: a `vX.Y.Z` tag publishes
`ghcr.io/justmytwospence/paperless-mcp:X.Y.Z`, `:X.Y` and `:X` (amd64 and arm64).

## Credits

This began as a fork of [baruchiro/paperless-mcp](https://github.com/baruchiro/paperless-mcp)
(ISC) by Baruch Odem, whose document, note, query and custom-field handling it still
builds on, and became its own project at 3.0.0. The semantic search design takes ideas
from [OrellBuehler/paperless-mcp](https://github.com/OrellBuehler/paperless-mcp) (sqlite-vec,
hash-gated re-embedding) and [hensing/searchless-ngx](https://github.com/hensing/searchless-ngx)
(chunked retrieval, watermark sync, filters with vector ranking); no code was copied from
either. Embeddings: [BAAI/bge-small-en-v1.5](https://huggingface.co/BAAI/bge-small-en-v1.5)
(MIT) through [transformers.js](https://github.com/huggingface/transformers.js).

## License

[ISC](LICENSE).
