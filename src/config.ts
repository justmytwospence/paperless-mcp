// Every environment variable the server reads, in one place.

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`${name} must be a number, got "${raw}"`);
  }
  return n;
}

export const PAPERLESS_URL = (process.env.PAPERLESS_URL || "").replace(/\/+$/, "");
export const PAPERLESS_API_KEY = process.env.PAPERLESS_API_KEY || "";
// Browser-facing URL for document links; the API URL may only resolve inside a
// container network.
export const PAPERLESS_PUBLIC_URL = (process.env.PAPERLESS_PUBLIC_URL || PAPERLESS_URL).replace(
  /\/+$/,
  ""
);

// Confine the server to these document types (comma-separated names or ids),
// e.g. "Academic". Unset: the whole library.
export const DOCUMENT_TYPES = (process.env.PAPERLESS_MCP_DOCUMENT_TYPES || "")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

export const MAX_FILE_SIZE_BYTES = int("PAPERLESS_MCP_MAX_FILE_BYTES", 100 * 1024 * 1024);
export const UPLOAD_ROOT = process.env.PAPERLESS_MCP_UPLOAD_ROOT || "";

// Semantic search. Off unless a data directory is given, so a stdio run against a
// remote Paperless does not start embedding the library by surprise.
export const DATA_DIR = process.env.PAPERLESS_MCP_DATA_DIR || "";
export const EMBEDDING_MODEL = process.env.PAPERLESS_MCP_EMBEDDING_MODEL || "Xenova/bge-small-en-v1.5";
// The image ships the model here (pinned and checksummed at build time); without
// it, the model is downloaded into DATA_DIR/models on first start.
export const MODEL_DIR = process.env.PAPERLESS_MCP_MODEL_DIR || "";
export const CHUNK_TOKENS = int("PAPERLESS_MCP_CHUNK_TOKENS", 480);
export const CHUNK_OVERLAP_TOKENS = int("PAPERLESS_MCP_CHUNK_OVERLAP_TOKENS", 64);
export const SYNC_INTERVAL_MINUTES = int("PAPERLESS_MCP_SYNC_INTERVAL_MINUTES", 10);
export const RECONCILE_INTERVAL_MINUTES = int("PAPERLESS_MCP_RECONCILE_INTERVAL_MINUTES", 60);
export const EMBED_THREADS = int("PAPERLESS_MCP_EMBED_THREADS", 1);
