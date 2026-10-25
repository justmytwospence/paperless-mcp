import type {
  BulkEditDocumentsResult,
  BulkEditParameters,
  Correspondent,
  CustomField,
  Document,
  DocumentsResponse,
  DocumentType,
  GetCorrespondentsResponse,
  GetCustomFieldsResponse,
  GetDocumentTypesResponse,
  GetTagsResponse,
  Note,
  Tag,
} from "./types.js";

export class PaperlessError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly responseData?: unknown
  ) {
    super(message);
  }
}

export interface BinaryResponse {
  data: Buffer;
  contentType?: string;
}

export type UploadMetadata = Record<
  string,
  string | string[] | number | number[] | undefined
>;

// Paperless caps page_size at 100000; the taxonomy lists are small, and fetching
// them whole is what lets names be resolved for every id.
const ALL = "page_size=100000";
const TAXONOMY_TTL_MS = 60_000;

export class OutOfScopeError extends PaperlessError {
  constructor(what: string) {
    super(`${what} is not in this server's library.`, 404);
  }
}

export interface PaperlessAPIOptions {
  /**
   * The library this client is confined to. Every document read, search, edit and
   * upload stays inside it, so one Paperless can back several MCP libraries.
   * Types are names or ids; no options means the whole Paperless.
   */
  documentTypes?: string[];
  /** Everything except these types (untyped documents included). */
  excludeDocumentTypes?: string[];
  /** Type given to uploads that do not name one; defaults to the only included type. */
  uploadDocumentType?: string;
}

/** Taxonomy shared by every library in one Paperless. */
export type TaxonomyKind = "tags" | "correspondents" | "custom_fields" | "storage_paths";

const TAXONOMY_LABEL: Record<TaxonomyKind, string> = {
  tags: "Tag",
  correspondents: "Correspondent",
  custom_fields: "Custom field",
  storage_paths: "Storage path",
};

/** Per kind: object id -> how many of the library's documents use it (only those > 0). */
export type TaxonomyUsage = Record<TaxonomyKind, Map<number, number>>;

interface TaxonomyItem {
  id: number;
  document_count?: number;
  children?: unknown[];
}

/** A resolved library scope: document type ids. */
export interface Scope {
  include: number[] | null;
  exclude: number[] | null;
  uploadType: number | null;
}

const clean = (list?: string[]) => (list || []).map((t) => t.trim()).filter(Boolean);

export function scopeAllows(scope: Scope | null, typeId: number | null): boolean {
  if (!scope) return true;
  if (scope.include) return typeId !== null && scope.include.includes(typeId);
  if (scope.exclude) return typeId === null || !scope.exclude.includes(typeId);
  return true;
}

export class PaperlessAPI {
  private readonly apiVersion = process.env.PAPERLESS_API_VERSION || "9";
  private readonly cache = new Map<string, { at: number; value: Promise<unknown> }>();
  private scopePromise?: Promise<Scope | null>;

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly options: PaperlessAPIOptions = {}
  ) {}

  /** The library's scope, or null for the whole Paperless. Resolved once. */
  scope(): Promise<Scope | null> {
    const include = clean(this.options.documentTypes);
    const exclude = clean(this.options.excludeDocumentTypes);
    const upload = this.options.uploadDocumentType?.trim();
    if (!include.length && !exclude.length) return Promise.resolve(null);
    if (include.length && exclude.length) {
      return Promise.reject(new Error("a library takes document_types or exclude_document_types, not both"));
    }
    this.scopePromise ??= (async () => {
      const all = await this.request<GetDocumentTypesResponse>(`/document_types/?${ALL}`);
      const resolve = (w: string) => {
        const hit = (all.results || []).find(
          (t) => String(t.id) === w || t.name.toLowerCase() === w.toLowerCase()
        );
        if (!hit) throw new Error(`no document type "${w}" in Paperless`);
        return hit.id;
      };
      const scope: Scope = {
        include: include.length ? [...new Set(include.map(resolve))] : null,
        exclude: exclude.length ? [...new Set(exclude.map(resolve))] : null,
        uploadType: null,
      };
      if (upload) scope.uploadType = resolve(upload);
      else if (scope.include?.length === 1) scope.uploadType = scope.include[0];
      if (scope.uploadType !== null && !scopeAllows(scope, scope.uploadType)) {
        throw new Error(`upload document type "${upload}" is outside the library`);
      }
      return scope;
    })();
    this.scopePromise.catch(() => (this.scopePromise = undefined));
    return this.scopePromise;
  }

  /** Included type ids, or null when the scope is not an include list (for listing types). */
  async scopeTypeIds(): Promise<number[] | null> {
    return (await this.scope())?.include ?? null;
  }

  private async scopeQuery(): Promise<string> {
    const scope = await this.scope();
    if (scope?.include) return `document_type__id__in=${scope.include.join(",")}`;
    if (scope?.exclude) return `document_type__id__none=${scope.exclude.join(",")}`;
    return "";
  }

  /** The ids that exist and are in scope (all of them on an unscoped server). */
  async documentsInScope(ids: number[]): Promise<Set<number>> {
    const unique = [...new Set(ids)];
    if (!(await this.scope()) || !unique.length) return new Set(unique);
    const res = await this.getDocuments(
      `?id__in=${unique.join(",")}&fields=id&page_size=${unique.length}`
    );
    return new Set((res.results || []).map((d) => d.id));
  }

  /** Throws OutOfScopeError unless every document is in scope (and exists). */
  async assertInScope(ids: number[]): Promise<void> {
    if (!(await this.scope()) || !ids.length) return;
    const found = await this.documentsInScope(ids);
    const missing = [...new Set(ids)].filter((id) => !found.has(id));
    if (missing.length) throw new OutOfScopeError(`Document ${missing.join(", ")}`);
  }

  /**
   * Consume tasks this client started. A task's outcome can name a document in
   * another library (Paperless detects duplicates across all of them), so a scoped
   * server only reports tasks it started itself, or ones whose document is its own.
   */
  private readonly tasks = new Map<string, number>();

  rememberTask(taskId: string): void {
    this.tasks.set(taskId, Date.now());
    // Bounded: the oldest are forgotten first (Map keeps insertion order).
    while (this.tasks.size > 5000) this.tasks.delete(this.tasks.keys().next().value!);
  }

  startedTask(taskId: string): boolean {
    return this.tasks.has(taskId);
  }

  /** Throws unless assigning this document type (null: none) keeps a document in scope. */
  async assertTypeInScope(typeId: number | null | undefined): Promise<void> {
    if (typeId === undefined) return;
    if (!scopeAllows(await this.scope(), typeId)) {
      throw new OutOfScopeError(`Document type ${typeId}`);
    }
  }

  /**
   * How the library's documents use the shared taxonomy, or null on an unscoped
   * server. One selection_data call over the library's document ids, cached with
   * the rest of the taxonomy.
   */
  async taxonomyUsage(): Promise<TaxonomyUsage | null> {
    if (!(await this.scope())) return null;
    return this.cached("usage", async () => {
      const usage: TaxonomyUsage = {
        tags: new Map(),
        correspondents: new Map(),
        custom_fields: new Map(),
        storage_paths: new Map(),
      };
      const ids = (await this.getDocuments("?page_size=1&fields=id")).all || [];
      if (!ids.length) return usage;
      const sel = await this.raw<Record<string, Array<{ id: number; document_count: number }>>>(
        "/documents/selection_data/",
        { method: "POST", body: JSON.stringify({ documents: ids }) }
      );
      for (const kind of Object.keys(usage) as TaxonomyKind[]) {
        for (const { id, document_count } of sel[`selected_${kind}`] || []) {
          if (document_count > 0) usage[kind].set(id, document_count);
        }
      }
      return usage;
    });
  }

  /**
   * A scoped library sees a taxonomy object when one of its documents uses it, or
   * when no document uses it at all (just created). What only other libraries use
   * stays hidden, names included.
   */
  private static visible(usage: TaxonomyUsage, kind: TaxonomyKind, item: TaxonomyItem): boolean {
    return usage[kind].has(item.id) || !item.document_count;
  }

  /**
   * The objects of a list the library may see, with document_count counting only
   * the library's documents (and tag children narrowed the same way).
   */
  async scopeTaxonomy<T extends TaxonomyItem>(kind: TaxonomyKind, items: T[]): Promise<T[]> {
    const usage = await this.taxonomyUsage();
    if (!usage) return items;
    let visibleIds: Set<number> | undefined;
    if (kind === "tags" && items.some((t) => Array.isArray(t.children) && t.children.length)) {
      const all = (await this.getTags()).results || [];
      visibleIds = new Set(all.filter((t) => PaperlessAPI.visible(usage, kind, t)).map((t) => t.id));
    }
    return items
      .filter((item) => PaperlessAPI.visible(usage, kind, item))
      .map((item) => {
        const out = { ...item, document_count: usage[kind].get(item.id) ?? 0 };
        if (visibleIds && Array.isArray(item.children)) {
          out.children = item.children.filter((c) => {
            const id = typeof c === "number" ? c : (c as { id?: number })?.id;
            return typeof id === "number" && visibleIds!.has(id);
          });
        }
        return out;
      });
  }

  private allTaxonomy(kind: TaxonomyKind): Promise<{ results?: TaxonomyItem[] }> {
    switch (kind) {
      case "tags":
        return this.getTags();
      case "correspondents":
        return this.getCorrespondents();
      case "custom_fields":
        return this.getCustomFields();
      case "storage_paths":
        return this.cached("storage_paths", () => this.request(`/storage_paths/?${ALL}`));
    }
  }

  /**
   * Throws OutOfScopeError for any referenced taxonomy object the library cannot
   * see, so an id cannot be attached to one of its documents to read the name back.
   * A missing id gets the same answer as a hidden one.
   */
  async assertTaxonomyInScope(
    refs: Partial<Record<TaxonomyKind, Array<number | null | undefined> | undefined>>
  ): Promise<void> {
    const kinds = (Object.keys(refs) as TaxonomyKind[]).filter((k) =>
      (refs[k] || []).some((n) => typeof n === "number")
    );
    // Most writes reference no taxonomy: no extra Paperless call for them.
    if (!kinds.length) return;
    const usage = await this.taxonomyUsage();
    if (!usage) return;
    for (const kind of kinds) {
      const wanted = [...new Set((refs[kind] || []).filter((n): n is number => typeof n === "number"))];
      let all = (await this.allTaxonomy(kind)).results || [];
      if (wanted.some((id) => !all.some((i) => i.id === id))) {
        // Possibly created since the list was cached.
        this.cache.delete(kind);
        all = (await this.allTaxonomy(kind)).results || [];
      }
      for (const id of wanted) {
        const item = all.find((i) => i.id === id);
        if (!item || !PaperlessAPI.visible(usage, kind, item)) {
          throw new OutOfScopeError(`${TAXONOMY_LABEL[kind]} ${id}`);
        }
      }
    }
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Token ${this.token}`,
      Accept: `application/json; version=${this.apiVersion}`,
      "Accept-Language": "en-US,en;q=0.9",
      ...extra,
    };
  }

  private async fail(res: Response, url: string, method: string): Promise<never> {
    if (res.status === 406) {
      throw new PaperlessError(
        `HTTP 406: Paperless-ngx rejected API version ${this.apiVersion}. ` +
          `Set PAPERLESS_API_VERSION to a version your server supports.`,
        406
      );
    }
    const text = await res.text().catch(() => "");
    if (res.status === 404 && /\/documents\/\d+/.test(url)) {
      // Same answer as an out-of-scope document, so scope cannot be probed.
      throw new OutOfScopeError(`Document ${url.match(/\/documents\/(\d+)/)![1]}`);
    }
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // Not JSON; keep the text.
    }
    const b = body as Record<string, unknown> | undefined;
    const message =
      (b && typeof b === "object" && (b.detail || b.error || b.message)) ||
      `HTTP error! status: ${res.status}`;
    console.error({ error: "Error executing request", url, method, status: res.status, response: body });
    throw new PaperlessError(String(message), res.status, body);
  }

  /**
   * Raw API access for everything except documents, which must go through the
   * scoped methods below.
   */
  async request<T = any>(path: string, options: RequestInit = {}): Promise<T> {
    if (/^\/documents(\/|\?|$)/.test(path)) {
      throw new Error(`request(): use the document methods for ${path}`);
    }
    return this.raw<T>(path, options);
  }

  private async raw<T = any>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}/api${path}`;
    const method = options.method || "GET";
    const isJson = !options.body || typeof options.body === "string";
    const res = await fetch(url, {
      ...options,
      method,
      headers: this.headers({
        ...(isJson ? { "Content-Type": "application/json" } : {}),
        ...((options.headers as Record<string, string>) || {}),
      }),
    });
    if (!res.ok) {
      return this.fail(res, url, method);
    }
    if (res.status === 204) {
      return undefined as T;
    }
    const text = await res.text();
    if (!text) {
      return undefined as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }

  private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < TAXONOMY_TTL_MS) {
      return hit.value as Promise<T>;
    }
    const value = load();
    this.cache.set(key, { at: Date.now(), value });
    value.catch(() => this.cache.delete(key));
    return value;
  }

  invalidateTaxonomy(): void {
    this.cache.clear();
  }

  private async binary(path: string): Promise<BinaryResponse> {
    const url = `${this.baseUrl}/api${path}`;
    const res = await fetch(url, { headers: { Authorization: `Token ${this.token}` } });
    if (!res.ok) {
      return this.fail(res, url, "GET");
    }
    return {
      data: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get("content-type") || undefined,
    };
  }

  // Documents

  async bulkEditDocuments(
    documents: number[],
    method: string,
    parameters: BulkEditParameters = {}
  ): Promise<BulkEditDocumentsResult> {
    await this.assertInScope(documents);
    if (method === "set_document_type") await this.assertTypeInScope(parameters.document_type ?? null);
    const p = parameters as Record<string, unknown>;
    await this.assertTaxonomyInScope({
      tags: method === "add_tag" ? [p.tag as number] : method === "modify_tags" ? (p.add_tags as number[]) : [],
      correspondents: method === "set_correspondent" ? [p.correspondent as number] : [],
      storage_paths: method === "set_storage_path" ? [p.storage_path as number] : [],
      custom_fields:
        method === "modify_custom_fields"
          ? Object.keys((p.add_custom_fields as Record<string, unknown>) || {}).map(Number)
          : [],
    });
    this.cache.delete("usage");
    return this.raw<BulkEditDocumentsResult>("/documents/bulk_edit/", {
      method: "POST",
      body: JSON.stringify({ documents, method, parameters }),
    });
  }

  async postDocument(
    document: Buffer,
    filename: string,
    metadata: UploadMetadata = {},
    /** Tags the server itself adds (the uploader tag), exempt from the taxonomy scope. */
    trustedTags: number[] = []
  ): Promise<string> {
    await this.assertTaxonomyInScope({
      tags: ((metadata.tags as number[]) || []).map(Number).filter((t) => !trustedTags.includes(t)),
      correspondents: [metadata.correspondent as number | undefined].map((v) => (v === undefined ? v : Number(v))),
      storage_paths: [metadata.storage_path as number | undefined].map((v) => (v === undefined ? v : Number(v))),
      custom_fields: ((metadata.custom_fields as number[]) || []).map(Number),
    });
    this.cache.delete("usage");
    const scope = await this.scope();
    if (scope) {
      if (metadata.document_type === undefined && scope.uploadType !== null) {
        metadata = { ...metadata, document_type: scope.uploadType };
      }
      await this.assertTypeInScope(
        metadata.document_type === undefined ? null : Number(metadata.document_type)
      );
    }
    const form = new FormData();
    form.append("document", new Blob([new Uint8Array(document)]), filename);
    for (const key of ["title", "created", "correspondent", "document_type", "storage_path"]) {
      const value = metadata[key];
      if (value !== undefined && value !== null && value !== "") {
        form.append(key, String(value));
      }
    }
    if (metadata.archive_serial_number !== undefined) {
      form.append("archive_serial_number", String(metadata.archive_serial_number));
    }
    for (const tag of (metadata.tags as Array<string | number>) || []) {
      form.append("tags", String(tag));
    }
    for (const field of (metadata.custom_fields as number[]) || []) {
      form.append("custom_fields", String(field));
    }
    const url = `${this.baseUrl}/api/documents/post_document/`;
    const res = await fetch(url, { method: "POST", headers: this.headers(), body: form });
    if (!res.ok) {
      return this.fail(res, url, "POST");
    }
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Not JSON; keep the text.
    }
    if (typeof parsed === "string" && !/^\d+$/.test(parsed)) this.rememberTask(parsed);
    return parsed as string;
  }

  async getDocuments(query = ""): Promise<DocumentsResponse> {
    // Appended last: Django reads the last value of a repeated parameter, so a
    // caller's own document_type__id__in / __none cannot widen the scope.
    const scope = await this.scopeQuery();
    const q = scope ? (query ? `${query}&${scope}` : `?${scope}`) : query;
    return this.raw<DocumentsResponse>(`/documents/${q}`);
  }

  async getDocument(id: number): Promise<Document> {
    const doc = await this.raw<Document>(`/documents/${id}/`);
    if (!scopeAllows(await this.scope(), doc.document_type)) {
      throw new OutOfScopeError(`Document ${id}`);
    }
    return doc;
  }

  async updateDocument(id: number, data: Record<string, unknown>): Promise<Document> {
    await this.assertInScope([id]);
    if ("document_type" in data) await this.assertTypeInScope(data.document_type as number | null);
    await this.assertTaxonomyInScope({
      tags: data.tags as number[] | undefined,
      correspondents: [data.correspondent as number | null | undefined],
      storage_paths: [data.storage_path as number | null | undefined],
      custom_fields: ((data.custom_fields as Array<{ field: number }> | undefined) || []).map((f) => f.field),
    });
    this.cache.delete("usage");
    return this.raw<Document>(`/documents/${id}/`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }

  async downloadDocument(id: number, asOriginal = false): Promise<BinaryResponse> {
    await this.assertInScope([id]);
    return this.binary(`/documents/${id}/download/${asOriginal ? "?original=true" : ""}`);
  }

  async getThumbnail(id: number): Promise<BinaryResponse> {
    await this.assertInScope([id]);
    return this.binary(`/documents/${id}/thumb/`);
  }

  // Notes

  async getDocumentNotes(documentId: number): Promise<Note[]> {
    await this.assertInScope([documentId]);
    return this.raw<Note[]>(`/documents/${documentId}/notes/`);
  }

  async createDocumentNote(documentId: number, note: string): Promise<Note[]> {
    await this.assertInScope([documentId]);
    return this.raw<Note[]>(`/documents/${documentId}/notes/`, {
      method: "POST",
      body: JSON.stringify({ note }),
    });
  }

  async deleteDocumentNote(documentId: number, noteId: number): Promise<Note[]> {
    await this.assertInScope([documentId]);
    return this.raw<Note[]>(`/documents/${documentId}/notes/?id=${noteId}`, {
      method: "DELETE",
    });
  }

  // Taxonomy. The unfiltered getters return every object (cached briefly), which
  // is what name resolution needs; the list tools pass their own query string.

  async getTags(queryString?: string): Promise<GetTagsResponse> {
    if (queryString) return this.request(`/tags/?${queryString}`);
    return this.cached("tags", () => this.request(`/tags/?${ALL}`));
  }

  async createTag(data: Partial<Tag>): Promise<Tag> {
    this.invalidateTaxonomy();
    return this.request<Tag>("/tags/", { method: "POST", body: JSON.stringify(data) });
  }

  async updateTag(id: number, data: Partial<Tag>): Promise<Tag> {
    await this.assertTaxonomyInScope({ tags: [id] });
    this.invalidateTaxonomy();
    return this.request<Tag>(`/tags/${id}/`, { method: "PATCH", body: JSON.stringify(data) });
  }

  async getCorrespondents(queryString?: string): Promise<GetCorrespondentsResponse> {
    if (queryString) return this.request(`/correspondents/?${queryString}`);
    return this.cached("correspondents", () => this.request(`/correspondents/?${ALL}`));
  }

  async createCorrespondent(data: Partial<Correspondent>): Promise<Correspondent> {
    this.invalidateTaxonomy();
    return this.request<Correspondent>("/correspondents/", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async getDocumentTypes(queryString?: string): Promise<GetDocumentTypesResponse> {
    if (queryString) return this.request(`/document_types/?${queryString}`);
    return this.cached("document_types", () => this.request(`/document_types/?${ALL}`));
  }

  async createDocumentType(data: Partial<DocumentType>): Promise<DocumentType> {
    this.invalidateTaxonomy();
    return this.request<DocumentType>("/document_types/", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async getCustomFields(queryString?: string): Promise<GetCustomFieldsResponse> {
    if (queryString) return this.request(`/custom_fields/?${queryString}`);
    return this.cached("custom_fields", () => this.request(`/custom_fields/?${ALL}`));
  }

  async getCustomField(id: number): Promise<CustomField> {
    const all = await this.getCustomFields();
    const hit = (all.results || []).find((f) => f.id === id);
    return hit ?? this.request<CustomField>(`/custom_fields/${id}/`);
  }
}
