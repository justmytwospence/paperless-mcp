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

export class PaperlessAPI {
  private readonly apiVersion = process.env.PAPERLESS_API_VERSION || "9";
  private readonly cache = new Map<string, { at: number; value: Promise<unknown> }>();

  constructor(
    private readonly baseUrl: string,
    private readonly token: string
  ) {}

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

  async request<T = any>(path: string, options: RequestInit = {}): Promise<T> {
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
    return this.request<BulkEditDocumentsResult>("/documents/bulk_edit/", {
      method: "POST",
      body: JSON.stringify({ documents, method, parameters }),
    });
  }

  async postDocument(
    document: Buffer,
    filename: string,
    metadata: UploadMetadata = {}
  ): Promise<string> {
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
    return this.request<DocumentsResponse>(`/documents/${query}`);
  }

  async getDocument(id: number): Promise<Document> {
    return this.request<Document>(`/documents/${id}/`);
  }

  async updateDocument(id: number, data: Record<string, unknown>): Promise<Document> {
    return this.request<Document>(`/documents/${id}/`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }

  async downloadDocument(id: number, asOriginal = false): Promise<BinaryResponse> {
    return this.binary(`/documents/${id}/download/${asOriginal ? "?original=true" : ""}`);
  }

  async getThumbnail(id: number): Promise<BinaryResponse> {
    return this.binary(`/documents/${id}/thumb/`);
  }

  // Notes

  async getDocumentNotes(documentId: number): Promise<Note[]> {
    return this.request<Note[]>(`/documents/${documentId}/notes/`);
  }

  async createDocumentNote(documentId: number, note: string): Promise<Note[]> {
    return this.request<Note[]>(`/documents/${documentId}/notes/`, {
      method: "POST",
      body: JSON.stringify({ note }),
    });
  }

  async deleteDocumentNote(documentId: number, noteId: number): Promise<Note[]> {
    return this.request<Note[]>(`/documents/${documentId}/notes/?id=${noteId}`, {
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
