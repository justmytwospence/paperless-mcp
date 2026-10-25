import { createHash } from "node:crypto";
import type { PaperlessAPI } from "../api/PaperlessAPI.js";
import type { CustomField, Document, Note } from "../api/types.js";
import { chunkText } from "./chunk.js";
import type { Embedder } from "./embed.js";
import type { ChunkKind, DocRecord, StoredChunk, VectorStore } from "./store.js";

export interface SyncOptions {
  chunkTokens: number;
  overlapTokens: number;
  /** Chunks per embedding call; small, so queries interleave with a backfill. */
  batchSize?: number;
  /** Base delay between fetch retries (default 1000 ms; grows quadratically). */
  retryDelayMs?: number;
  log?: (message: string) => void;
}

export interface SyncStatus {
  documents_indexed: number;
  documents_total: number | null;
  chunks: number;
  syncing: boolean;
  last_sync: string | null;
  last_error: string | null;
}

type IndexableDoc = Pick<
  Document,
  "id" | "title" | "content" | "modified" | "notes" | "tags" | "correspondent" | "document_type" | "custom_fields" | "created_date"
>;

const DOC_FIELDS =
  "id,title,content,modified,notes,tags,correspondent,document_type,custom_fields,created_date";

async function withRetry<T>(fn: () => Promise<T>, delayMs: number, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, delayMs * i * i));
    }
  }
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 32);

export function notesText(notes: Note[] | undefined): string {
  return (notes || [])
    .map((n) => n.note?.trim())
    .filter(Boolean)
    .join("\n\n");
}

interface Names {
  tags: Map<number, string>;
  correspondents: Map<number, string>;
  documentTypes: Map<number, string>;
  customFields: Map<number, CustomField>;
}

function customFieldText(field: CustomField | undefined, value: unknown): string | null {
  if (!field || value === null || value === undefined || value === "") return null;
  if (field.data_type === "documentlink") return null;
  if (field.data_type === "select") {
    const options = (field.extra_data as { select_options?: unknown[] } | null)?.select_options || [];
    const hit = options.find(
      (o, i) => (o && typeof o === "object" ? (o as { id?: unknown }).id === value : i === value)
    );
    if (hit && typeof hit === "object") return String((hit as { label?: unknown }).label);
    if (typeof hit === "string") return hit;
  }
  return String(value);
}

/** The descriptive text indexed beside the content: what the document is, and the notes on it. */
export function metadataText(doc: IndexableDoc, names: Names): string {
  const lines = [`Title: ${doc.title}`];
  if (doc.correspondent) lines.push(`Correspondent: ${names.correspondents.get(doc.correspondent) ?? doc.correspondent}`);
  if (doc.document_type) lines.push(`Type: ${names.documentTypes.get(doc.document_type) ?? doc.document_type}`);
  if (doc.tags?.length) lines.push(`Tags: ${doc.tags.map((t) => names.tags.get(t) ?? t).join(", ")}`);
  if (doc.created_date) lines.push(`Date: ${doc.created_date}`);
  for (const cf of doc.custom_fields || []) {
    const field = names.customFields.get(cf.field);
    const text = customFieldText(field, cf.value);
    if (text) lines.push(`${field!.name}: ${text}`);
  }
  return lines.join("\n");
}

/**
 * Keeps the vector index in step with Paperless. A reconcile pass walks every
 * document id (cheap fields only) to index what is missing, drop what is gone and
 * catch new notes, which do not bump a document's modified time; an incremental
 * pass re-reads what changed since the watermark. Content is only re-embedded when
 * its hash changes, so a tag edit on a 900-page book costs one small chunk.
 */
export class Syncer {
  private running: Promise<void> = Promise.resolve();
  private status: SyncStatus = {
    documents_indexed: 0,
    documents_total: null,
    chunks: 0,
    syncing: false,
    last_sync: null,
    last_error: null,
  };
  private timers: NodeJS.Timeout[] = [];
  private errors: Record<string, string> = {};
  /** Set when a reconcile left documents unindexed; the next tick retries it. */
  private reconcilePending = false;
  private get retryDelay() {
    return this.opts.retryDelayMs ?? 1000;
  }

  constructor(
    private readonly api: PaperlessAPI,
    private readonly store: VectorStore,
    private readonly embedder: Embedder,
    private readonly opts: SyncOptions
  ) {
    this.refreshCounts();
  }

  getStatus(): SyncStatus {
    this.refreshCounts();
    const errors = Object.entries(this.errors).map(([k, v]) => `${k}: ${v}`);
    return { ...this.status, last_error: errors.length ? errors.join("; ") : null };
  }

  private refreshCounts() {
    const c = this.store.counts();
    this.status.documents_indexed = c.documents;
    this.status.chunks = c.chunks;
  }

  private log(message: string) {
    (this.opts.log ?? console.error)(`[sync] ${message}`);
  }

  /** Serialises passes: a reconcile and an incremental never run at once. */
  private enqueue(name: string, pass: () => Promise<void>): Promise<void> {
    this.running = this.running.then(async () => {
      this.status.syncing = true;
      try {
        await pass();
        this.status.last_sync = new Date().toISOString();
        // A pass clears only its own error: an incremental success says nothing
        // about documents a failed reconcile left behind.
        if (!this.errors[name]?.startsWith("partial:")) delete this.errors[name];
      } catch (err) {
        this.errors[name] = err instanceof Error ? err.message : String(err);
        if (name === "reconcile") this.reconcilePending = true;
        this.log(`${name} failed: ${this.errors[name]}`);
      } finally {
        this.status.syncing = false;
        this.refreshCounts();
      }
    });
    return this.running;
  }

  start(incrementalMinutes: number, reconcileMinutes: number): void {
    void this.reconcile().then(() => this.incremental());
    if (incrementalMinutes > 0) {
      this.timers.push(
        setInterval(
          () => void (this.reconcilePending ? this.reconcile() : this.incremental()),
          incrementalMinutes * 60_000
        )
      );
    }
    if (reconcileMinutes > 0) {
      this.timers.push(setInterval(() => void this.reconcile(), reconcileMinutes * 60_000));
    }
    for (const t of this.timers) t.unref();
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  reconcile(): Promise<void> {
    return this.enqueue("reconcile", async () => {
      const live = new Map<number, { modified: string; notes_hash: string }>();
      for (let page = 1; ; page++) {
        const res = await this.api.getDocuments(`?fields=id,modified,notes&page_size=1000&page=${page}`);
        for (const d of res.results || []) {
          live.set(d.id, { modified: d.modified, notes_hash: sha(notesText(d.notes)) });
        }
        if (!res.next) break;
      }
      this.status.documents_total = live.size;

      const indexed = new Map(this.store.allDocs().map((d) => [d.doc_id, d]));
      let removed = 0;
      for (const id of indexed.keys()) {
        if (!live.has(id)) {
          this.store.removeDocument(id);
          removed++;
        }
      }
      const todo = [...live.entries()]
        .filter(([id, d]) => {
          const have = indexed.get(id);
          return !have || have.notes_hash !== d.notes_hash || have.modified !== d.modified;
        })
        .map(([id]) => id)
        // Newest first: the papers just added are the ones most likely asked about.
        .sort((a, b) => b - a);
      if (removed || todo.length) {
        this.log(`reconcile: ${todo.length} to index, ${removed} removed, ${live.size} in Paperless`);
      }
      // One document per request: a page of full texts can run to hundreds of MB
      // (books), which servers and proxies cut off. One failing document is retried
      // and then skipped, never the whole pass.
      const failed: string[] = [];
      for (let i = 0; i < todo.length; i++) {
        try {
          const doc = await withRetry(() => this.fetchDocument(todo[i]), this.retryDelay);
          if (doc) await this.indexDocument(doc);
        } catch (err) {
          failed.push(`${todo[i]} (${err instanceof Error ? err.message : String(err)})`);
        }
        if (i % 100 === 99) this.log(`reconcile: ${i + 1}/${todo.length}`);
      }
      this.reconcilePending = failed.length > 0;
      if (failed.length) {
        this.errors.reconcile = `partial: ${failed.length} document(s) not indexed, retrying: ${failed.slice(0, 3).join(", ")}`;
        this.log(this.errors.reconcile);
      } else {
        delete this.errors.reconcile;
      }
      this.bumpWatermark([...live.values()].map((d) => d.modified));
    });
  }

  incremental(): Promise<void> {
    return this.enqueue("incremental", async () => {
      const watermark = this.store.getMeta("watermark");
      if (!watermark) return; // the reconcile pass sets it
      const changed: Array<{ id: number; modified: string }> = [];
      for (let page = 1; ; page++) {
        const res = await this.api.getDocuments(
          `?modified__gte=${encodeURIComponent(watermark)}&ordering=modified&fields=id,modified&page_size=500&page=${page}`
        );
        changed.push(...(res.results || []).map((d) => ({ id: d.id, modified: d.modified })));
        if (!res.next) break;
      }
      const seen: string[] = [];
      for (const { id, modified } of changed) {
        try {
          const doc = await withRetry(() => this.fetchDocument(id), this.retryDelay);
          if (doc) await this.indexDocument(doc);
        } catch (err) {
          // Left to the reconcile pass, which re-checks every document.
          this.reconcilePending = true;
          this.log(`incremental: document ${id} not indexed, left for reconcile: ${err instanceof Error ? err.message : String(err)}`);
        }
        seen.push(modified);
      }
      this.bumpWatermark(seen);
    });
  }

  private async fetchDocument(id: number): Promise<IndexableDoc | undefined> {
    const res = await this.api.getDocuments(`?id__in=${id}&fields=${DOC_FIELDS}&page_size=1`);
    return res.results?.[0];
  }

  private bumpWatermark(modified: string[]) {
    const current = this.store.getMeta("watermark");
    const latest = modified.reduce<string | undefined>(
      (max, m) => (!max || Date.parse(m) > Date.parse(max) ? m : max),
      current
    );
    if (latest && latest !== current) this.store.setMeta("watermark", latest);
  }

  private async names(): Promise<Names> {
    const [tags, correspondents, documentTypes, customFields] = await Promise.all([
      this.api.getTags(),
      this.api.getCorrespondents(),
      this.api.getDocumentTypes(),
      this.api.getCustomFields(),
    ]);
    return {
      tags: new Map((tags.results || []).map((t) => [t.id, t.name])),
      correspondents: new Map((correspondents.results || []).map((c) => [c.id, c.name])),
      documentTypes: new Map((documentTypes.results || []).map((d) => [d.id, d.name])),
      customFields: new Map((customFields.results || []).map((f) => [f.id, f])),
    };
  }

  /** Indexes one document, re-embedding only the parts whose text changed. */
  async indexDocument(doc: IndexableDoc): Promise<void> {
    const names = await this.names();
    const content = doc.content || "";
    const meta = metadataText(doc, names);
    const notes = notesText(doc.notes);
    const record: DocRecord = {
      doc_id: doc.id,
      modified: doc.modified,
      content_hash: sha(`${doc.title}\n${content}`),
      meta_hash: sha(meta),
      notes_hash: sha(notes),
    };
    const have = this.store.getDoc(doc.id);
    const contentChanged = !have || have.content_hash !== record.content_hash;
    const metaChanged = !have || have.meta_hash !== record.meta_hash || have.notes_hash !== record.notes_hash;
    if (!contentChanged && !metaChanged) {
      if (have.modified !== doc.modified) this.store.touchDocument(doc.id, doc.modified);
      return;
    }

    const count = (t: string) => this.embedder.countTokens(t);
    const titlePrefix = `${doc.title}\n\n`;
    const budget = Math.max(64, this.opts.chunkTokens - count(titlePrefix));
    const chunks: Array<Omit<StoredChunk, "embedding"> & { embedText: string }> = [];
    const kinds: ChunkKind[] = [];

    if (metaChanged) {
      kinds.push("meta");
      const metaBody = notes ? `${meta}\n\nNotes:\n${notes}` : meta;
      chunkText(metaBody, {
        maxTokens: this.opts.chunkTokens,
        overlapTokens: this.opts.overlapTokens,
        countTokens: count,
      }).forEach((c, i) =>
        chunks.push({
          chunk_no: -(i + 1),
          kind: "meta",
          start: null,
          end: null,
          text: c.text,
          embedText: i === 0 ? c.text : titlePrefix + c.text,
        })
      );
    }
    if (contentChanged) {
      kinds.push("content");
      chunkText(content, {
        maxTokens: budget,
        overlapTokens: this.opts.overlapTokens,
        countTokens: count,
      }).forEach((c, i) =>
        chunks.push({
          chunk_no: i,
          kind: "content",
          start: c.start,
          end: c.end,
          text: c.text,
          embedText: titlePrefix + c.text,
        })
      );
    }

    const batch = this.opts.batchSize ?? 8;
    const stored: StoredChunk[] = [];
    for (let i = 0; i < chunks.length; i += batch) {
      const slice = chunks.slice(i, i + batch);
      const vectors = await this.embedder.embedDocuments(slice.map((c) => c.embedText));
      slice.forEach(({ embedText: _e, ...c }, j) => stored.push({ ...c, embedding: vectors[j] }));
      await new Promise((r) => setImmediate(r));
    }
    this.store.replaceDocument(record, stored, have ? kinds : undefined);
  }
}
