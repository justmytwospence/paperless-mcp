# Tools

Every tool carries MCP annotations: read-only tools are marked `readOnlyHint`, and the
two that can discard something (`bulk_edit_documents` and `delete_document_note`) are
marked `destructiveHint`, so a client can auto-approve reads and ask before the rest. Document results include `web_url`, a link to the document in the
Paperless web UI; the server's instructions ask agents to cite documents with it.

On a server with [libraries](configuration.md#libraries), every tool works inside the
library: documents outside it do not exist as far as the tools are concerned.

## Finding documents

### `semantic_search`

Documents ranked by meaning, each with its best-matching passages. Present when semantic
search is enabled ([how it works](semantic-search.md)).

| Argument | | |
|---|---|---|
| `query` | required | What you are looking for, in natural language |
| `limit` | 10 (max 50) | Documents to return |
| `hybrid` | `true` | Fuse with Paperless keyword search; `false` for meaning only |
| `passages_per_document` | 2 (0-5) | Passages per document |
| `passage_chars` | 600 (100-4000) | Truncate passages to this length |
| `tag_ids` | | Only documents with all of these tags |
| `correspondent_id`, `document_type_id` | | Only documents with this correspondent / type |
| `created_after`, `created_before` | | `YYYY-MM-DD`, inclusive |

Each result: `id`, `title`, `web_url`, `created_date`, `correspondent`, `document_type`,
`tags`, `score` (fused), `similarity` (cosine, or null if it matched by keyword only),
`keyword_rank`, `matched_by` (`semantic`, `keyword`), and `passages` (`text`, `kind`:
`content` or `meta`, `offset` and `length` in the document text, `similarity`). The
response ends with `index` coverage.

### `query_documents`

Paperless's full-text search and every documented `/api/documents/` filter.

- `query`: Paperless's [query language](https://docs.paperless-ngx.com/usage/#basic-usage_searching)
  (`title:invoice created:[2024 to 2025] tag:tax`).
- `more_like_id`: documents similar to a given one (Paperless's keyword similarity).
- First-class filters: `correspondent`, `document_type`, `tag`, `storage_path`,
  `created__date__gte`/`__lte`, `archive_serial_number`, `custom_fields__icontains`,
  `search`, `ordering`, `page`, `page_size`.
- `custom_field_query`: `["Year", "gte", 2020]`, or groups such as
  `["AND", [["Year", "gte", 2020], ["Journal", "icontains", "Nature"]]]`.
- `paperless_filters`: any other documented parameter by its exact name
  (`{"tags__id__none": "3", "is_in_inbox": true}`); unknown names are refused.

Results are metadata (content excluded); read text with `get_document_content`.

### `list_documents`

The same filters without the full-text query, for browsing and paging.

## Reading

| Tool | |
|---|---|
| `get_document` | Full metadata: correspondent, type, tags and custom fields with names, notes, dates |
| `get_document_content` | OCR text. `offset` and `max_chars` read a slice; the response gives `total_chars`. Long books are read in slices, starting from a passage's offset |
| `download_document` | A `paperless://documents/<id>/download` resource URI (`original: true` for the file as uploaded rather than the archived PDF); read the resource for the bytes |
| `get_document_thumbnail` | A `paperless://documents/<id>/thumb` resource URI (WebP) |

## Filing

### `post_document_from_url`

The server downloads a file and uploads it to Paperless. Use the direct file link (for
arXiv, `/pdf/<id>`, not `/abs/<id>`); an HTML page is rejected rather than filed. Only
public addresses are fetched (see [Security](deployment.md#security)).

Metadata: `title`, `filename`, `created`, `correspondent`, `document_type`,
`storage_path`, `tags`, `archive_serial_number`, `custom_fields` (ids). `wait_seconds`
(0-120, default 30) waits for Paperless to consume the file and reports the outcome:

- `created`, with `document_id` and `web_url`;
- `duplicate`, with the existing document it matched (Paperless refuses duplicates);
- `failed`, with Paperless's reason;
- `pending`: check later with `get_task_status(task_id)`.

### `post_document_from_file`

For a file the agent already holds: it saves the file into its own folder of the upload
area and passes `path: "agent-<name>/<file>"`. Same metadata and outcomes; the document is
also tagged `agent-<name>`. Present when an upload root is configured
([Uploads](configuration.md#uploads)).

### `get_task_status`

The outcome of an upload, by the task id it returned.

## Editing

### `update_document`

Change `title`, `correspondent`, `document_type`, `storage_path`, `tags`, `content`,
`created`, `archive_serial_number`, `owner` or `custom_fields`. Omitted fields are left
alone, with one exception: `custom_fields` replaces the document's whole set. To change
one field, use `bulk_edit_documents` with `modify_custom_fields`.

Custom field values: select fields take the option's label (translated to what Paperless
stores); monetary fields take a currency prefix (`USD10.00`, not `10.00$`); document link
fields take an id or a list of ids.

### `bulk_edit_documents`

One operation over many documents: `set_correspondent`, `set_document_type`,
`set_storage_path`, `add_tag`, `remove_tag`, `modify_tags` (`add_tags`, `remove_tags`),
`modify_custom_fields` (`add_custom_fields`, `remove_custom_fields`), `reprocess`,
`set_permissions` (`set_permissions`, `owner`, `merge`), `merge`, `split`, `rotate`,
`delete_pages`.

Removing a tag only removes it from these documents. `delete_pages`, and `merge` or
`split` with `delete_originals`, discard content and require `confirm: true`. There is no
way to delete a document.

## Notes

| Tool | |
|---|---|
| `list_document_notes` | A document's notes |
| `create_document_note` | Add a note (an audit trail, a reading note, a reminder) |
| `delete_document_note` | Delete one note by id; requires `confirm: true` |

Notes are indexed for semantic search.

## Taxonomy

| Tool | |
|---|---|
| `list_tags`, `list_correspondents`, `list_document_types`, `list_custom_fields` | With `name__icontains` and friends, `ordering`, paging. Agents are told to fetch a list once and match names locally |
| `create_tag`, `update_tag` | Name, color, automatic matching rule |
| `create_correspondent` | Name, matching rule |
| `create_document_type` | Name, matching rule. Not offered by a library (a new type would fall outside it) |

Tags, correspondents and document types cannot be deleted here: removing one changes
every document that uses it, which is a decision for the Paperless UI.
