# Semantic search

`semantic_search` answers "which documents are about this?" for questions whose answer
does not share your words: "papers on borrowing strength across groups" finds work on
hierarchical models, "the warranty for the dishwasher" finds a scan titled with a model
number.

## What gets indexed

For every document the server can see (in its library):

- **Content chunks**: the OCR text, split into chunks of about 480 model tokens at
  sentence and paragraph boundaries, with 64 tokens of overlap. There is no cap per
  document: a 900-page book is covered to its last page. Each chunk is embedded with the
  document title in front of it, so passages keep their context.
- **A metadata chunk**: title, correspondent, type, tags, date and custom fields, followed
  by the document's notes. Notes you or your agents leave become searchable.

The model is [bge-small-en-v1.5](https://huggingface.co/BAAI/bge-small-en-v1.5) (384
dimensions, English), run through ONNX on the CPU. Queries get bge's retrieval
instruction prefix; passages do not, as the model was trained. Vectors are stored in
SQLite with [sqlite-vec](https://github.com/asg017/sqlite-vec), one file per library.

## How a query is answered

1. The query is embedded, and the nearest chunks are found by cosine similarity.
2. In parallel, Paperless's own full-text search runs the same query.
3. The two rankings are combined by reciprocal rank fusion (`hybrid: true`, the default),
   so a document that matches exact words and meaning ranks first, and one that only
   matches either still appears. `hybrid: false` ranks by meaning alone.
4. Filters (`tag_ids`, `correspondent_id`, `document_type_id`, `created_after`,
   `created_before`) are evaluated by Paperless first, then ranking happens within that set.
5. Each document comes back with its best passages (`passages_per_document`, default 2,
   truncated to `passage_chars`, default 600). A content passage carries its `offset` and
   `length` in the document text, so the agent can read around it with
   `get_document_content(id, offset, max_chars)`.

Every response ends with the index's coverage:

```json
"index": { "documents_indexed": 812, "documents_total": 1027, "syncing": true,
           "complete": false, "last_error": null }
```

An agent can tell "not found" from "not indexed yet", and the tool's description tells it to.

## Keeping in sync

- **Incremental pass** (every `PAPERLESS_MCP_SYNC_INTERVAL_MINUTES`, default 10): reads the
  documents modified since the last pass and re-indexes them.
- **Reconcile pass** (at startup, then every `PAPERLESS_MCP_RECONCILE_INTERVAL_MINUTES`,
  default 60): lists every document id, indexes what is missing, drops what was deleted or
  left the library, and catches new notes (which do not change a document's modified time).
- **Only changed text is re-embedded.** Content and metadata are hashed separately: a tag
  or title change re-embeds one small metadata chunk, an OCR fix re-embeds the content.
- A document that cannot be fetched is retried, then skipped and retried at the next tick;
  `last_error` says which, and stays set until it is indexed.
- The newest documents are indexed first: they are the ones most likely asked about.

## Sizing

Measured on a 12-core Intel NUC, fp32, 480-token chunks:

| | 1 thread | 4 threads |
|---|---|---|
| Embedding | ~0.46 s per chunk | ~0.21 s per chunk |
| First build | ~7,000 chunks per hour | ~17,000 chunks per hour |

A chunk is about 1,900 characters of OCR text, roughly a page. A library of 1,000
documents with 130 MB of text (papers and some textbooks) is about 75,000 chunks: around
4.5 hours on four threads. After that, syncing costs seconds a day. The index takes about
4 KB per chunk on disk (75,000 chunks: about 300 MB) and memory stays under 1 GB.

Search keeps working during the build; it simply covers what is indexed so far. The
model runs in its own worker thread, where documents are also chunked (tokenizing a book
takes seconds), so the build does not slow down the server's other tools; give it one
thread fewer than the CPUs the container may use.

## Privacy

Nothing leaves the machine: the model ships inside the image (pinned to a Hugging Face
revision and checksummed at build time), and embedding happens in the server process.
The index holds document text, so treat its directory like the documents themselves.

## Rebuilding and changing the model

The index is a cache of Paperless. Delete `index.db` (or a library's folder under the
data directory) and the next start rebuilds it. Setting `PAPERLESS_MCP_EMBEDDING_MODEL`
to another transformers.js feature-extraction model also rebuilds it automatically.
Outside the image, the model is downloaded on first use; a first start can fail while the
download is still being written, and succeeds on restart.

## Why not Paperless's own AI index?

Paperless-ngx 3 can build a vector index of its own, but exposes it only through its chat
endpoint, which always generates an LLM answer (with at most three references and no
passages). There is no route that returns ranked documents and passages, so this server
keeps its own index and leaves the reasoning to your agent.
