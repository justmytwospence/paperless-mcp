import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import * as sqliteVec from "sqlite-vec";

export type ChunkKind = "content" | "meta";

export interface StoredChunk {
  chunk_no: number;
  kind: ChunkKind;
  /** Offsets into the document's content; null for metadata chunks. */
  start: number | null;
  end: number | null;
  text: string;
  embedding: Float32Array;
}

export interface DocRecord {
  doc_id: number;
  modified: string;
  content_hash: string;
  meta_hash: string;
  notes_hash: string;
}

export interface ChunkHit {
  chunk_id: number;
  doc_id: number;
  chunk_no: number;
  kind: ChunkKind;
  start: number | null;
  end: number | null;
  text: string;
  similarity: number;
}

const SCHEMA_VERSION = "1";

/**
 * The vector index: one row per chunk in `chunks`, its embedding in the sqlite-vec
 * table `vecs` under the same rowid. It holds nothing that cannot be rebuilt from
 * Paperless, so a model or schema change simply starts it over.
 */
export class VectorStore {
  private readonly db: DatabaseSync;
  private readonly stmts: Record<string, StatementSync> = {};

  constructor(
    file: string,
    readonly model: string,
    readonly dims: number
  ) {
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file, { allowExtension: true });
    this.db.loadExtension(sqliteVec.getLoadablePath());
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    this.db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
    const identity = `${SCHEMA_VERSION}:${model}:${dims}`;
    if (this.getMeta("identity") !== identity) {
      this.reset();
      this.setMeta("identity", identity);
    }
    this.prepare();
  }

  private reset(): void {
    this.db.exec(`
      DROP TABLE IF EXISTS vecs;
      DROP TABLE IF EXISTS chunks;
      DROP TABLE IF EXISTS docs;
      DELETE FROM meta;
      CREATE TABLE docs (
        doc_id INTEGER PRIMARY KEY,
        modified TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        meta_hash TEXT NOT NULL,
        notes_hash TEXT NOT NULL,
        indexed_at TEXT NOT NULL
      );
      CREATE TABLE chunks (
        id INTEGER PRIMARY KEY,
        doc_id INTEGER NOT NULL,
        chunk_no INTEGER NOT NULL,
        kind TEXT NOT NULL,
        start INTEGER,
        "end" INTEGER,
        text TEXT NOT NULL
      );
      CREATE INDEX chunks_doc ON chunks (doc_id);
      CREATE VIRTUAL TABLE vecs USING vec0(embedding float[${this.dims}] distance_metric=cosine);
    `);
  }

  private prepare(): void {
    const s = (name: string, sql: string) => (this.stmts[name] = this.db.prepare(sql));
    s("getMeta", "SELECT value FROM meta WHERE key = ?");
    s("setMeta", "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    s("getDoc", "SELECT doc_id, modified, content_hash, meta_hash, notes_hash FROM docs WHERE doc_id = ?");
    s("allDocs", "SELECT doc_id, modified, content_hash, meta_hash, notes_hash FROM docs");
    s("countDocs", "SELECT count(*) AS n FROM docs");
    s("countChunks", "SELECT count(*) AS n FROM chunks");
    s("chunkIds", "SELECT id FROM chunks WHERE doc_id = ?");
    s("chunkIdsKind", "SELECT id FROM chunks WHERE doc_id = ? AND kind = ?");
    s("delChunksKind", "DELETE FROM chunks WHERE doc_id = ? AND kind = ?");
    s("delVec", "DELETE FROM vecs WHERE rowid = ?");
    s("delChunks", "DELETE FROM chunks WHERE doc_id = ?");
    s("delDoc", "DELETE FROM docs WHERE doc_id = ?");
    s("insChunk", 'INSERT INTO chunks (doc_id, chunk_no, kind, start, "end", text) VALUES (?, ?, ?, ?, ?, ?)');
    s("insVec", "INSERT INTO vecs (rowid, embedding) VALUES (?, ?)");
    s(
      "upsertDoc",
      `INSERT INTO docs (doc_id, modified, content_hash, meta_hash, notes_hash, indexed_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(doc_id) DO UPDATE SET modified = excluded.modified, content_hash = excluded.content_hash,
         meta_hash = excluded.meta_hash, notes_hash = excluded.notes_hash, indexed_at = excluded.indexed_at`
    );
    s("touchDoc", "UPDATE docs SET modified = ? WHERE doc_id = ?");
    s(
      "knn",
      `SELECT c.id AS chunk_id, c.doc_id, c.chunk_no, c.kind, c.start, c."end" AS "end", c.text, v.distance
       FROM vecs v JOIN chunks c ON c.id = v.rowid
       WHERE v.embedding MATCH ? AND k = ?
       ORDER BY v.distance`
    );
  }

  getMeta(key: string): string | undefined {
    const stmt = this.stmts.getMeta ?? this.db.prepare("SELECT value FROM meta WHERE key = ?");
    const row = stmt.get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    const stmt =
      this.stmts.setMeta ??
      this.db.prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      );
    stmt.run(key, value);
  }

  getDoc(docId: number): DocRecord | undefined {
    return this.stmts.getDoc.get(docId) as DocRecord | undefined;
  }

  allDocs(): DocRecord[] {
    return this.stmts.allDocs.all() as unknown as DocRecord[];
  }

  counts(): { documents: number; chunks: number } {
    return {
      documents: Number((this.stmts.countDocs.get() as { n: number }).n),
      chunks: Number((this.stmts.countChunks.get() as { n: number }).n),
    };
  }

  private transaction(fn: () => void): void {
    this.db.exec("BEGIN");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private deleteChunks(docId: number, kind?: ChunkKind): void {
    const ids = (
      kind ? this.stmts.chunkIdsKind.all(docId, kind) : this.stmts.chunkIds.all(docId)
    ) as Array<{ id: number }>;
    for (const row of ids) {
      this.stmts.delVec.run(BigInt(row.id));
    }
    if (kind) this.stmts.delChunksKind.run(docId, kind);
    else this.stmts.delChunks.run(docId);
  }

  /**
   * Replaces a document's chunks of the given kinds (all kinds by default) and
   * records its hashes, atomically.
   */
  replaceDocument(record: DocRecord, chunks: StoredChunk[], kinds?: ChunkKind[]): void {
    this.transaction(() => {
      if (kinds) for (const kind of kinds) this.deleteChunks(record.doc_id, kind);
      else this.deleteChunks(record.doc_id);
      for (const c of chunks) {
        if (c.embedding.length !== this.dims) {
          throw new Error(`embedding has ${c.embedding.length} dims, index expects ${this.dims}`);
        }
        const res = this.stmts.insChunk.run(record.doc_id, c.chunk_no, c.kind, c.start, c.end, c.text);
        this.stmts.insVec.run(BigInt(res.lastInsertRowid), c.embedding);
      }
      this.stmts.upsertDoc.run(
        record.doc_id,
        record.modified,
        record.content_hash,
        record.meta_hash,
        record.notes_hash,
        new Date().toISOString()
      );
    });
  }

  touchDocument(docId: number, modified: string): void {
    this.stmts.touchDoc.run(modified, docId);
  }

  removeDocument(docId: number): void {
    this.transaction(() => {
      this.deleteChunks(docId);
      this.stmts.delDoc.run(docId);
    });
  }

  /** Nearest chunks across the whole index. */
  nearest(query: Float32Array, k: number): ChunkHit[] {
    const rows = this.stmts.knn.all(query, k) as Array<Record<string, any>>;
    return rows.map(toHit);
  }

  /** Exact similarity of every chunk of the given documents (for filters and passages). */
  nearestWithin(query: Float32Array, docIds: number[], k: number): ChunkHit[] {
    if (!docIds.length) return [];
    const hits: ChunkHit[] = [];
    // Bound the parameter list; SQLite's default limit is 32766.
    for (let i = 0; i < docIds.length; i += 500) {
      const batch = docIds.slice(i, i + 500);
      const rows = this.db
        .prepare(
          `SELECT c.id AS chunk_id, c.doc_id, c.chunk_no, c.kind, c.start, c."end" AS "end", c.text,
                  vec_distance_cosine(v.embedding, ?) AS distance
           FROM chunks c JOIN vecs v ON v.rowid = c.id
           WHERE c.doc_id IN (${batch.map(() => "?").join(",")})`
        )
        .all(query, ...batch) as Array<Record<string, any>>;
      hits.push(...rows.map(toHit));
    }
    return hits.sort((a, b) => b.similarity - a.similarity).slice(0, k);
  }

  close(): void {
    this.db.close();
  }
}

function toHit(r: Record<string, any>): ChunkHit {
  return {
    chunk_id: Number(r.chunk_id),
    doc_id: Number(r.doc_id),
    chunk_no: Number(r.chunk_no),
    kind: r.kind,
    start: r.start === null ? null : Number(r.start),
    end: r.end === null ? null : Number(r.end),
    text: r.text,
    similarity: 1 - Number(r.distance),
  };
}
