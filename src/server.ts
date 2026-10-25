import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/server";
import type { PaperlessAPI } from "./api/PaperlessAPI.js";
import { registerDocumentResources } from "./resources/documents.js";
import type { SemanticSearch } from "./search/search.js";
import { registerDocumentTools } from "./tools/documents.js";
import { registerFileUploadTools } from "./tools/fileUpload.js";
import { registerNoteTools } from "./tools/notes.js";
import { registerSemanticSearchTools } from "./tools/semanticSearch.js";
import { registerTaxonomyTools } from "./tools/taxonomy.js";
import { registerUrlUploadTools } from "./tools/urlUpload.js";

export const SERVER_NAME = "paperless-mcp-server";
export const VERSION: string = createRequire(import.meta.url)("../package.json").version;

export interface ServerContext {
  api: PaperlessAPI;
  publicUrl: string;
  /** Present when semantic search is enabled; resolves once the model is loaded. */
  search?: Promise<SemanticSearch>;
  /** Confined to some document types (PAPERLESS_MCP_DOCUMENT_TYPES). */
  scoped?: boolean;
}

/**
 * Returns a factory for fully registered servers. The HTTP transport calls it once
 * per request, stdio once per process, so it does no I/O: the Paperless client and
 * the search index are shared and live in `ctx`.
 */
export function createServerFactory(ctx: ServerContext): () => McpServer {
  return () => {
    const server = new McpServer(
      { name: SERVER_NAME, version: VERSION },
      { instructions: buildInstructions(ctx.publicUrl, Boolean(ctx.search), Boolean(ctx.scoped)) }
    );
    if (ctx.search) registerSemanticSearchTools(server, ctx.search);
    registerDocumentTools(server, ctx.api);
    registerDocumentResources(server, ctx.api);
    registerNoteTools(server, ctx.api);
    registerTaxonomyTools(server, ctx.api, { scoped: Boolean(ctx.scoped) });
    registerUrlUploadTools(server, ctx.api);
    registerFileUploadTools(server, ctx.api);
    return server;
  };
}

function buildInstructions(publicUrl: string, semantic: boolean, scoped: boolean): string {
  const finding = semantic
    ? "To find documents about a topic, start with semantic_search (meaning, not exact words; returns matching passages). Use query_documents for exact phrases, titles and structured filters, and get_document_content to read a document (in slices for long ones)."
    : "To find documents, use query_documents (full-text and structured filters), then get_document_content to read one.";
  return [
    scoped
      ? "A Paperless-ngx library limited to some document types: only those documents exist here, and uploads are filed as one of them."
      : "Paperless-ngx document library.",
    finding,
    "To add a document from the web use post_document_from_url; for a file you hold, post_document_from_file. Notes (list/create_document_note) are free-text annotations on a document.",
    "This server cannot delete documents, tags, correspondents or document types. update_document's custom_fields replaces the whole set; use bulk_edit_documents with modify_custom_fields to change one field.",
    `When answering about a specific document, cite it with its clickable web_url (${publicUrl}/documents/<id>/details), not an ID, API URL or paperless:// URI.`,
  ].join("\n\n");
}
