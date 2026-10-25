import type { PaperlessAPI } from "../api/PaperlessAPI.js";
import type { Document } from "../api/types.js";
import { createDocument } from "./mocks/paperlessApi.js";

const page = <T>(results: T[], next: boolean) => ({
  count: results.length,
  next: next ? "next" : null,
  previous: null,
  all: [],
  results,
});

/**
 * An in-memory Paperless answering the /documents/ queries the indexer and
 * semantic_search make: paging, fields, id__in, modified__gte, tag/date filters,
 * and a naive `query` (documents containing every query word).
 */
export class FakePaperless {
  docs = new Map<number, Document>();
  requests: string[] = [];
  tags = [
    { id: 1, name: "statistics" },
    { id: 2, name: "household" },
  ];

  add(overrides: Partial<Document> & { id: number }): Document {
    const doc = createDocument({ modified: new Date(Date.now()).toISOString(), ...overrides });
    this.docs.set(doc.id, doc);
    return doc;
  }

  update(id: number, changes: Partial<Document>, modified = new Date().toISOString()) {
    const doc = this.docs.get(id)!;
    Object.assign(doc, changes, { modified });
  }

  get api(): PaperlessAPI {
    const self = this;
    const list = (items: { id: number; name: string }[]) => async () => page(items, false);
    return {
      getDocuments: async (query = "") => {
        self.requests.push(query);
        const q = new URLSearchParams(query.replace(/^\?/, ""));
        let docs = [...self.docs.values()];
        if (q.get("id__in")) {
          const ids = new Set(q.get("id__in")!.split(",").map(Number));
          docs = docs.filter((d) => ids.has(d.id));
        }
        if (q.get("modified__gte")) {
          const t = Date.parse(q.get("modified__gte")!);
          docs = docs.filter((d) => Date.parse(d.modified) >= t);
        }
        if (q.get("tags__id__all")) {
          const need = q.get("tags__id__all")!.split(",").map(Number);
          docs = docs.filter((d) => need.every((t) => d.tags.includes(t)));
        }
        if (q.get("created__date__gte")) docs = docs.filter((d) => d.created_date >= q.get("created__date__gte")!);
        if (q.get("created__date__lte")) docs = docs.filter((d) => d.created_date <= q.get("created__date__lte")!);
        if (q.get("query")) {
          const words = q.get("query")!.toLowerCase().split(/\s+/);
          docs = docs.filter((d) => words.every((w) => `${d.title} ${d.content}`.toLowerCase().includes(w)));
        }
        if (q.get("ordering") === "modified") docs.sort((a, b) => Date.parse(a.modified) - Date.parse(b.modified));
        else docs.sort((a, b) => a.id - b.id);
        const size = Number(q.get("page_size") || 25);
        const n = Number(q.get("page") || 1);
        const slice = docs.slice((n - 1) * size, n * size);
        const fields = q.get("fields")?.split(",");
        const shaped = fields
          ? slice.map((d) => Object.fromEntries(fields.map((f) => [f, (d as any)[f]])) as Document)
          : slice;
        return page(shaped, n * size < docs.length);
      },
      getTags: list(self.tags),
      getCorrespondents: list([{ id: 1, name: "Journal of Statistics" }]),
      getDocumentTypes: list([{ id: 1, name: "Paper" }]),
      getCustomFields: async () => page([{ id: 1, name: "Authors", data_type: "string" }], false),
    } as unknown as PaperlessAPI;
  }
}
