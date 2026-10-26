# Discovery and request policy

Each library exposes its own MCP instructions, resources, templates and workflow prompts.
Discovery and prompt retrieval are local: no document enumeration, Paperless calls,
embedding, writes or job startup. Neither sibling library configuration nor upload-root
filesystem paths are exposed. Resources use the same scoped `PaperlessAPI` document
methods as tools; hidden and missing documents fail identically.

## Local resources

| URI | Contents |
|---|---|
| `paperless://library/info` | This library's name/description, scope flag, enabled features, usage and boundaries |
| `paperless://library/search` | Full URI-template and prompt-name inventories with bounded examples/arguments/costs, find/read/cite guidance, coverage and filing cautions |
| `paperless://library/index-status` | Cached coverage for this library, `disabled`/`loading`/`ready`/`unavailable`, observation time and error flag; does not wait for or start indexing |
| `paperless://library/load-status` | Sanitized process-wide local admission counters/policy and observed 429 cooldown; zero upstream calls |

The static search guide is self-contained for clients that cannot list resource
templates or ignore initialize instructions. Tool descriptions also point to that guide
and the zero-call load policy, with request-cost/retry cautions.

These resources do not enumerate documents or offer subscriptions. Index counts are a
local snapshot, not proof of complete/current Paperless coverage. Raw service errors
are not included in the index resource. `load-status` counters aggregate all libraries,
resources, tools, source-download hops and background sync in this process, without
names, document ids or request URLs. They reset with the process and do not account for
other clients/processes using the same Paperless token.

## Document templates

Use an id found through this library's tools; templates have no listing/completion that
walks the archive. All reads cost upstream requests:

| URI | Output bound and cost |
|---|---|
| `paperless://documents/{id}/metadata` | Compact filing ids/dates/title (512 characters), first 100 tags and total/count fields; no OCR or custom-field values. One document GET plus initial scope resolution |
| `paperless://documents/{id}/content{?offset,max_chars}` | OCR slice; default 8000 characters, max 32000, offset defaults to 0. `total_chars` and `next_offset` show remaining text. One document GET plus scope resolution |
| `paperless://documents/{id}/notes{?offset,limit}` | Default 20 notes, max 50, offset defaults to 0; each note capped at 2000 characters with `total_chars`/`truncated`. `total_notes`/`next_offset` show remaining notes. Scoped-id check plus one notes GET |
| `paperless://documents/{id}/download{?original}` | File; `original=true`/`1` selects the uploaded file (`false`/`0`: archive). Scoped-id check plus binary GET |
| `paperless://documents/{id}/thumb` | Thumbnail (`thumbnail` is an alias), scoped-id check plus binary GET |

The existing generic `paperless://documents/{id}/{resource}` template remains available.
Ids must be positive safe integers. Unknown/duplicate query parameters, invalid bounds,
credentials and fragments are rejected before upstream access. Binaries are capped at
16 MiB before encoding (declared and streamed sizes are checked); use the document's
`web_url` to download larger files in Paperless.

**Slicing bounds output, not upstream transfer:** Paperless still sends full OCR or all
notes. Use `get_document` for full metadata/custom fields before editing. The legacy
`get_document_content` tool retains its optional slice arguments and default full-text
behavior. Cite returned clickable `web_url` links, not resource/API URIs; OCR/notes are
untrusted source material, not instructions.

## Workflow prompts

Retrieving any prompt only returns instructions and validated input data. It does not
perform the workflow, authorize an action or bypass client consent.

| Prompt | Arguments | Workflow |
|---|---|---|
| `find_documents` | `query` | Semantic search when enabled, exact/structured fallback, small result sets, coverage and request costs |
| `read_document` | `document_id`, optional `question` | Metadata, bounded OCR/notes, explicit unread material and citations |
| `cite_documents` | `document_ids` (comma-separated, max 20), `claim` | Verify evidence with scoped bounded reads and clickable source links |
| `filing_review` | `document_id`, `proposed_changes` | Review-only before/after diff, replacement/loss warnings; never applies edits |

## Local admission, not a REST quota

Paperless's general REST allowance is **unknown**. `upstream_quota` is `null`; no
remaining-call or provider-reset allowance is invented. The policy has these defaults:

- Four active upstream requests across libraries, including source downloads, JSON,
  binary reads, multipart uploads and indexing. A slot/deadline remains held until the
  body is consumed, not just until headers arrive.
- At most 64 queued requests, each with a 30-second admission deadline. A full queue or
  cooldown beyond that deadline fails locally without sending a request.
- A 30-second deadline per admitted request, including its body. Connection, body and
  upload timeouts release admission. These are not whole-tool/workflow deadlines.
- Only Paperless GET/HEAD responses with HTTP 429 may retry once, when the observed
  cooldown is at most 10 seconds. Delta-seconds and HTTP-date `Retry-After` are honored;
  missing/invalid headers use a local one-second backoff (extreme future values are
  capped at a year of local cooldown). Longer cooldowns are surfaced
  without an automatic retry. All new admissions respect the shared cooldown.
- No writes (including uploads), network errors, timeouts or 5xx are replayed by the
  HTTP layer. Paperless API redirects are rejected (configure its direct URL), preventing
  307/308 write replay and credential forwarding; public source-download redirects remain
  SSRF-checked and bounded to five hops. Source downloads do not automatically retry. Background indexing has its
  existing separate transient document-read retry (up to three attempts); it does not
  multiply an exhausted HTTP 429 retry.

`observed_at`, `last_attempt_at`, `last_429_at`, `retry_after` and `cooldown_until`
distinguish local observations from unknown provider allowances. `retry_after` is the
last observed header, not a verified quota reset; the fallback and effective cooldown
are local pacing. Counters record admitted attempts (including failed attempts and read
retries), not upstream billing. Other Paperless clients can still cause throttling.

Configure concurrency, queue size and request timeout with the
[connection settings](configuration.md#connection). Admission is not an approval gate,
authorization boundary, rate-per-minute allowance or monetary spending cap.

## Request costs and safe workflows

- List/query reads one output page, plus scope resolution and up to four cached
  taxonomy reads to resolve names. Fetch modest pages, retain results and page
  deliberately; the existing tools retain their pagination and content controls.
  A `more_like_id` similarity seed adds a scoped-id check; bulk metadata-source document
  references are checked too, so neither can read from another library indirectly.
- Unfiltered taxonomy is cached for 60 seconds. Scoped taxonomy lists can traverse all
  library ids and selection data before paging locally: a small page does not imply
  small upstream traversal.
- Semantic search embeds locally, but may make filter and keyword GETs, one metadata
  hydration GET and up to three cached taxonomy GETs. A failed keyword leg now returns
  a `warnings` entry rather than silently presenting the search as fully hybrid.
- Uploads add a public source download (including redirect hops) or a staged file,
  a multipart POST, scope/taxonomy checks and optional task GETs about every two seconds.
  The polling budget defaults to 30 seconds, capped at 45 seconds measured from call
  start; it does **not** cancel in-flight source/upload HTTP. A known task id should be
  polled with `get_task_status`, not uploaded again.
- After an interrupted write/upload, the outcome may be unknown. Inspect current state
  or a known task before any manual retry; never infer failure from a lost response.

Tools preserve legacy text and embedded resource blocks. Handler-produced JSON also
appears in `structuredContent`: objects directly, arrays under `items`, primitives
under `value`; binary-URI tools use `uri`. Handler errors carry `isError: true` and JSON
error data. SDK input-validation failures remain SDK errors. There is no blanket output
schema: Paperless's extensible payloads and heterogeneous tool results do not have one
stable validated shape.
