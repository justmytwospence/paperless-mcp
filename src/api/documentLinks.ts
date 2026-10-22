let publicBase = "";

// The API base URL may only resolve inside a container network; links handed to a
// user must use the browser-facing URL.
export function setPublicUrl(url: string): void {
  publicBase = url.replace(/\/+$/, "");
}

export function documentUrl(id: unknown): string | null {
  if (!publicBase || typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
    return null;
  }
  return `${publicBase}/documents/${id}/details`;
}

export const LINK_GUIDANCE =
  " When answering about a specific document, include a clickable Paperless UI link from its web_url field (not just an ID, title, API URL, or paperless:// resource URI).";
