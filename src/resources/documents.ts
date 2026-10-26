import {
  type BlobResourceContents,
  type McpServer,
  type ReadResourceResult,
  ResourceTemplate,
  type TextResourceContents,
} from "@modelcontextprotocol/server";
import { documentUrl } from "../api/documentLinks.js";
import type { BinaryResponse, PaperlessAPI } from "../api/PaperlessAPI.js";

type TemplateVariables = Record<string, string | string[]>;

export function registerDocumentResources(server: McpServer, api: PaperlessAPI) {
  const templates = [
    ["paperless-document-resource", "paperless://documents/{id}/{resource}",
      "Scoped document download or thumbnail (thumb). Reads Paperless; binaries capped at 16 MiB."],
    ["paperless-document-original-download", "paperless://documents/{id}/download{?original}",
      "Scoped file; original=true for the uploaded file. Reads Paperless; capped at 16 MiB."],
    ["paperless-document-metadata", "paperless://documents/{id}/metadata",
      "Scoped compact filing metadata, not OCR or custom-field values. One Paperless read plus scope resolution; no document enumeration."],
    ["paperless-document-content", "paperless://documents/{id}/content{?offset,max_chars}",
      "Scoped OCR slice: offset=0, max_chars=8000 (max 32000). One Paperless document read plus scope resolution; full OCR is fetched upstream, only output is sliced."],
    ["paperless-document-notes", "paperless://documents/{id}/notes{?offset,limit}",
      "Scoped notes: offset=0, limit=20 (max 50); each note capped at 2000 characters. Scope checks plus one Paperless notes read (all notes upstream)."],
  ] as const;
  for (const [name, template, description] of templates) {
    server.registerResource(name, new ResourceTemplate(template, { list: undefined }),
      { title: name.replaceAll("-", " "), description },
      (uri, variables) => readDocumentResource(api, uri, variables));
  }
}

export function jsonResource(uri: URL, value: unknown): ReadResourceResult {
  return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(value) }] };
}

/** Validate the URI itself, not merely the template variables extracted by the SDK. */
export async function readDocumentResource(
  api: PaperlessAPI,
  uri: URL,
  _variables: TemplateVariables
): Promise<ReadResourceResult> {
  const match = uri.pathname.match(/^\/([1-9]\d*)\/(download|thumb|thumbnail|metadata|content|notes)$/);
  if (uri.protocol !== "paperless:" || uri.hostname !== "documents" || uri.username ||
      uri.password || uri.port || uri.hash || !match || !Number.isSafeInteger(Number(match[1]))) {
    throw new Error("Invalid Paperless document resource URI");
  }
  const id = Number(match[1]);
  const kind = match[2];
  const allowed = kind === "content" ? ["offset", "max_chars"] : kind === "notes" ? ["offset", "limit"] : kind === "download" ? ["original"] : [];
  for (const key of uri.searchParams.keys()) {
    if (!allowed.includes(key) || uri.searchParams.getAll(key).length !== 1) throw new Error("Invalid Paperless resource query");
  }
  if (kind === "content") {
    const offset = boundedInt(uri, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
    const max = boundedInt(uri, "max_chars", 8000, 1, 32000);
    const doc = await api.getDocument(id);
    const full = doc.content || "";
    const start = Math.min(offset, full.length);
    const end = Math.min(full.length, start + max);
    return jsonResource(uri, {
      id, title: doc.title.slice(0, 512), web_url: documentUrl(id),
      total_chars: full.length, offset: start, content: full.slice(start, end),
      next_offset: end < full.length ? end : null,
    });
  }
  if (kind === "metadata") {
    const doc = await api.getDocument(id);
    return jsonResource(uri, {
      id, title: doc.title.slice(0, 512), web_url: documentUrl(id),
      correspondent: doc.correspondent, document_type: doc.document_type,
      storage_path: doc.storage_path, created: doc.created, modified: doc.modified,
      archive_serial_number: doc.archive_serial_number,
      tags: (doc.tags || []).slice(0, 100), total_tags: (doc.tags || []).length,
      custom_field_count: (doc.custom_fields || []).length,
      detail_note: "Compact metadata only. Use get_document for full metadata and custom fields before editing.",
    });
  }
  if (kind === "notes") {
    const offset = boundedInt(uri, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = boundedInt(uri, "limit", 20, 1, 50);
    const notes = await api.getDocumentNotes(id);
    const start = Math.min(offset, notes.length);
    const end = Math.min(notes.length, start + limit);
    return jsonResource(uri, {
      id, web_url: documentUrl(id), total_notes: notes.length, offset: start,
      notes: notes.slice(start, end).map((n) => ({
        id: n.id, created: n.created, note: n.note.slice(0, 2000),
        total_chars: n.note.length, truncated: n.note.length > 2000,
      })),
      next_offset: end < notes.length ? end : null,
    });
  }
  let response: BinaryResponse;
  if (kind === "download") {
    const original = uri.searchParams.get("original");
    if (original !== null && !["true", "false", "1", "0"].includes(original)) throw new Error("Invalid original flag");
    response = await api.downloadDocument(id, original === "true" || original === "1");
  } else {
    response = await api.getThumbnail(id);
  }
  return { contents: [responseToResourceContents(uri.href, response, kind === "download" ? "application/octet-stream" : "image/webp")] };
}

function boundedInt(uri: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = uri.searchParams.get(name);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < min || n > max) throw new Error(`Invalid ${name} in Paperless resource URI`);
  return n;
}

function responseToResourceContents(uri: string, response: BinaryResponse, fallbackMimeType: string): TextResourceContents | BlobResourceContents {
  const mimeType = response.contentType || fallbackMimeType;
  const normalized = mimeType.split(";")[0].trim().toLowerCase();
  if (normalized.startsWith("text/") || normalized === "application/json" || normalized === "application/xml" || normalized.endsWith("+json") || normalized.endsWith("+xml")) {
    return { uri, mimeType, text: response.data.toString("utf8") };
  }
  return { uri, mimeType, blob: response.data.toString("base64") };
}
