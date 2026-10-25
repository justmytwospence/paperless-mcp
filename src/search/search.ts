import type { PaperlessAPI } from "../api/PaperlessAPI.js";
import { documentUrl } from "../api/documentLinks.js";
import type { Embedder } from "./embed.js";
import type { ChunkHit, VectorStore } from "./store.js";
import type { SyncStatus } from "./sync.js";

export interface SemanticSearchArgs {
  query: string;
  limit?: number;
  hybrid?: boolean;
  passages_per_document?: number;
  passage_chars?: number;
  tag_ids?: number[];
  correspondent_id?: number;
  document_type_id?: number;
  created_after?: string;
  created_before?: string;
}

export interface Passage {
  text: string;
  kind: "content" | "meta";
  chunk_no: number;
  /** Character offset in the document content, for get_document_content. */
  offset: number | null;
  length: number | null;
  similarity: number;
}

export interface SearchResult {
  id: number;
  title: string;
  web_url: string | null;
  created_date?: string;
  correspondent?: string | null;
  document_type?: string | null;
  tags?: string[];
  score: number;
  similarity: number | null;
  keyword_rank: number | null;
  matched_by: Array<"semantic" | "keyword">;
  passages: Passage[];
}

// Reciprocal rank fusion constant; 60 is the value from the original paper and
// the common default. It flattens the head of each list so neither dominates.
const RRF_K = 60;

function filterQuery(args: SemanticSearchArgs): string | null {
  const q = new URLSearchParams();
  if (args.tag_ids?.length) q.set("tags__id__all", args.tag_ids.join(","));
  if (args.correspondent_id !== undefined) q.set("correspondent__id", String(args.correspondent_id));
  if (args.document_type_id !== undefined) q.set("document_type__id", String(args.document_type_id));
  if (args.created_after) q.set("created__date__gte", args.created_after);
  if (args.created_before) q.set("created__date__lte", args.created_before);
  return q.toString() || null;
}

function trimPassage(hit: ChunkHit, maxChars: number): Passage {
  const text = hit.text.length > maxChars ? `${hit.text.slice(0, maxChars).trimEnd()} ...` : hit.text;
  return {
    text,
    kind: hit.kind,
    chunk_no: hit.chunk_no,
    offset: hit.start,
    length: hit.start === null || hit.end === null ? null : hit.end - hit.start,
    similarity: Number(hit.similarity.toFixed(4)),
  };
}

export class SemanticSearch {
  constructor(
    private readonly api: PaperlessAPI,
    private readonly store: VectorStore,
    private readonly embedder: Embedder,
    private readonly status: () => SyncStatus
  ) {}

  async search(args: SemanticSearchArgs) {
    const limit = Math.min(Math.max(args.limit ?? 10, 1), 50);
    const perDoc = Math.min(Math.max(args.passages_per_document ?? 2, 0), 5);
    const passageChars = Math.min(Math.max(args.passage_chars ?? 600, 100), 4000);
    const hybrid = args.hybrid ?? true;
    const filters = filterQuery(args);

    // Filters are Paperless's to evaluate: it knows the tags and dates, and its
    // answer also honours permissions. The vector side then ranks within that set.
    let allowed: number[] | null = null;
    if (filters) {
      const res = await this.api.getDocuments(`?${filters}&fields=id&page_size=100000`);
      allowed = (res.results || []).map((d) => d.id);
    }

    const queryVec = await this.embedder.embedQuery(args.query);
    const pool = limit * 8;
    const hits =
      allowed === null
        ? this.store.nearest(queryVec, pool)
        : this.store.nearestWithin(queryVec, allowed, pool);

    const vectorRank = new Map<number, { rank: number; similarity: number }>();
    for (const h of hits) {
      if (!vectorRank.has(h.doc_id)) {
        vectorRank.set(h.doc_id, { rank: vectorRank.size + 1, similarity: h.similarity });
      }
    }

    const keywordRank = new Map<number, number>();
    if (hybrid) {
      try {
        const res = await this.api.getDocuments(
          `?query=${encodeURIComponent(args.query)}${filters ? `&${filters}` : ""}&fields=id&page_size=${limit * 2}`
        );
        (res.results || []).forEach((d, i) => keywordRank.set(d.id, i + 1));
      } catch {
        // A query the full-text parser rejects (stray quotes, operators) still
        // gets semantic results.
      }
    }

    const ids = new Set([...vectorRank.keys(), ...keywordRank.keys()]);
    const scored = [...ids]
      .map((id) => {
        const v = vectorRank.get(id);
        const k = keywordRank.get(id);
        const score = (v ? 1 / (RRF_K + v.rank) : 0) + (k ? 1 / (RRF_K + k) : 0);
        return { id, v, k, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    const top = scored.map((s) => s.id);
    const passages = new Map<number, ChunkHit[]>();
    if (perDoc > 0 && top.length) {
      for (const hit of this.store.nearestWithin(queryVec, top, top.length * 50)) {
        const list = passages.get(hit.doc_id) ?? [];
        if (list.length < perDoc) list.push(hit);
        passages.set(hit.doc_id, list);
      }
    }

    const details = new Map<number, any>();
    if (top.length) {
      const [docs, tags, correspondents, types] = await Promise.all([
        this.api.getDocuments(
          `?id__in=${top.join(",")}&fields=id,title,created_date,correspondent,document_type,tags&page_size=${top.length}`
        ),
        this.api.getTags(),
        this.api.getCorrespondents(),
        this.api.getDocumentTypes(),
      ]);
      const tagNames = new Map((tags.results || []).map((t) => [t.id, t.name]));
      const corrNames = new Map((correspondents.results || []).map((c) => [c.id, c.name]));
      const typeNames = new Map((types.results || []).map((t) => [t.id, t.name]));
      for (const d of docs.results || []) {
        details.set(d.id, {
          title: d.title,
          created_date: d.created_date,
          correspondent: d.correspondent ? corrNames.get(d.correspondent) ?? null : null,
          document_type: d.document_type ? typeNames.get(d.document_type) ?? null : null,
          tags: (d.tags || []).map((t) => tagNames.get(t) ?? String(t)),
        });
      }
    }

    const results: SearchResult[] = scored
      // A document missing from Paperless's answer was deleted (or hidden) since
      // it was indexed: leave it out rather than return a dead link.
      .filter((s) => details.has(s.id))
      .map((s) => ({
        id: s.id,
        ...details.get(s.id),
        web_url: documentUrl(s.id),
        score: Number(s.score.toFixed(5)),
        similarity: s.v ? Number(s.v.similarity.toFixed(4)) : null,
        keyword_rank: s.k ?? null,
        matched_by: [...(s.v ? ["semantic" as const] : []), ...(s.k ? ["keyword" as const] : [])],
        passages: (passages.get(s.id) || []).map((h) => trimPassage(h, passageChars)),
      }));

    const st = this.status();
    return {
      query: args.query,
      results,
      index: {
        documents_indexed: st.documents_indexed,
        documents_total: st.documents_total,
        syncing: st.syncing,
        complete: st.documents_total !== null && st.documents_indexed >= st.documents_total,
        last_error: st.last_error,
      },
    };
  }
}
