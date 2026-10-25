import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import * as config from "./config.js";

/**
 * A library: one MCP endpoint over part of Paperless. A server can host several
 * (`PAPERLESS_MCP_LIBRARIES`), each with its own documents, uploads and index.
 */
export interface Library {
  /** URL segment: served at /<name>/mcp. "default" (the env-only setup) is at /mcp. */
  name: string;
  /** One line telling agents what this library holds. */
  description?: string;
  documentTypes: string[];
  excludeDocumentTypes: string[];
  uploadDocumentType?: string;
  /** Enables post_document_from_file: a folder of agent-<name>/ subfolders. */
  uploadRoot?: string;
  /** Directory for this library's semantic index; unset disables semantic search. */
  dataDir?: string;
}

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

const librarySchema = z
  .object({
    name: z.string().regex(NAME, "name: lowercase letters, digits and dashes"),
    description: z.string().optional(),
    document_types: z.array(z.string()).optional(),
    exclude_document_types: z.array(z.string()).optional(),
    upload_document_type: z.string().optional(),
    upload_root: z.string().optional(),
    semantic_search: z.boolean().optional(),
  })
  .strict()
  .refine((l) => !(l.document_types?.length && l.exclude_document_types?.length), {
    message: "use document_types or exclude_document_types, not both",
  });

const fileSchema = z.object({ libraries: z.array(librarySchema).min(1) }).strict();

export function parseLibraries(json: unknown, dataDir: string): Library[] {
  const parsed = fileSchema.parse(json);
  const names = new Set<string>();
  return parsed.libraries.map((l) => {
    if (names.has(l.name)) throw new Error(`library "${l.name}" is defined twice`);
    names.add(l.name);
    return {
      name: l.name,
      description: l.description,
      documentTypes: l.document_types ?? [],
      excludeDocumentTypes: l.exclude_document_types ?? [],
      uploadDocumentType: l.upload_document_type,
      uploadRoot: l.upload_root,
      dataDir: dataDir && l.semantic_search !== false ? path.join(dataDir, l.name) : undefined,
    };
  });
}

/**
 * Libraries from PAPERLESS_MCP_LIBRARIES (a JSON file path, or inline JSON), or a
 * single "default" library from the plain environment variables.
 */
export function loadLibraries(): Library[] {
  const raw = process.env.PAPERLESS_MCP_LIBRARIES?.trim();
  if (!raw) {
    return [
      {
        name: "default",
        documentTypes: config.DOCUMENT_TYPES,
        excludeDocumentTypes: config.EXCLUDE_DOCUMENT_TYPES,
        uploadDocumentType: config.UPLOAD_DOCUMENT_TYPE || undefined,
        uploadRoot: config.UPLOAD_ROOT || undefined,
        dataDir: config.DATA_DIR || undefined,
      },
    ];
  }
  const text = raw.startsWith("{") ? raw : readFileSync(raw, "utf8");
  try {
    return parseLibraries(JSON.parse(text), config.DATA_DIR);
  } catch (err) {
    throw new Error(`PAPERLESS_MCP_LIBRARIES: ${err instanceof Error ? err.message : String(err)}`);
  }
}
