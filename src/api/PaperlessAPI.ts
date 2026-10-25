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

  /** Throws OutOfScopeError unless every document is in scope (and exists). */
  async assertInScope(ids: number[]): Promise<void> {
    if (!(await this.scope()) || !ids.length) return;
    const unique = [...new Set(ids)];
    const res = await this.getDocuments(
      `?id__in=${unique.join(",")}&fields=id&page_size=${unique.length}`
    );
    const found = new Set((res.results || []).map((d) => d.id));
    const missing = unique.filter((id) => !found.has(id));
    if (missing.length) throw new OutOfScopeError(`Document ${missing.join(", ")}`);
  }

  /** Throws unless assigning this document type (null: none) keeps a document in scope. */
  async assertTypeInScope(typeId: number | null | undefined): Promise<void> {
    if (typeId === undefined) return;
    if (!scopeAllows(await this.scope(), typeId)) {
      throw new OutOfScopeError(`Document type ${typeId}`);
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
    return this.raw<BulkEditDocumentsResult>("/documents/bulk_edit/", {
      method: "POST",
      body: JSON.stringify({ documents, method, parameters }),
    });
  }

  async postDocument(
    document: Buffer,
    filename: string,
    metadata: UploadMetadata = {}
  ): Promise<string> {
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
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
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
