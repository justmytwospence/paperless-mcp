import type { CallToolResult, McpServer, ToolAnnotations } from "@modelcontextprotocol/server";
import { z } from "zod";

type Shape = z.ZodRawShape;

/** Runtime input validation is performed by the SDK using the same zod schema. */
export function registerTool<S extends Shape>(
  server: McpServer,
  name: string,
  description: string,
  shape: S,
  annotations: ToolAnnotations,
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<CallToolResult>
): void {
  server.registerTool(
    name,
    {
      title: name.split("_").map((part) => part[0].toUpperCase() + part.slice(1)).join(" "),
      description: description + (annotations.openWorldHint
        ? annotations.readOnlyHint
          ? " Uses Paperless; scope checks, name resolution and pagination may add requests. GET/HEAD 429 retries at most once after a short cooldown; use bounded pages and reuse results. Zero-call local load status: paperless://library/load-status (upstream quota unknown). Full template/prompt usage: paperless://library/search."
          : " Writes are never automatically replayed, including after 429 or timeout. An interrupted write may have succeeded: inspect state before retrying. Scope checks and upload polling add requests. Before batches, read paperless://library/load-status (zero-call local policy; upstream quota unknown) and paperless://library/search for filing cautions and request costs."
        : " Generates a URI locally; reading that resource makes scoped Paperless requests (16 MiB binary cap). Zero-call load policy/cooldown: paperless://library/load-status; usage and templates: paperless://library/search."),
      inputSchema: z.object(shape), annotations,
    },
    (async (args: z.infer<z.ZodObject<S>>) => {
      try {
        return withStructuredContent(await handler(args));
      } catch (err) {
        const e = err as { message?: string; status?: number; responseData?: unknown };
        return {
          ...jsonResult({
            error: err instanceof Error ? err.message : String(err),
            responseData: e?.responseData,
            status: e?.status,
          }),
          isError: true,
        };
      }
    }) as any
  );
}

/** Add machine-readable data without changing any legacy text/resource blocks. */
function withStructuredContent(result: CallToolResult): CallToolResult {
  if (result.structuredContent || result.content[0]?.type !== "text") return result;
  const text = result.content[0].text;
  let value: unknown;
  try { value = JSON.parse(text); } catch {
    // The binary tools historically return a bare URI, not JSON.
    if (text.startsWith("paperless://")) return { ...result, structuredContent: { uri: text } };
    return result;
  }
  const structuredContent = value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : Array.isArray(value) ? { items: value } : { value };
  return { ...result, structuredContent };
}

export function jsonResult(value: unknown, pretty = false): CallToolResult {
  return withStructuredContent({
    content: [{ type: "text", text: JSON.stringify(value, null, pretty ? 2 : undefined) }],
  });
}

export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

export const LOCAL_READ_ONLY: ToolAnnotations = { ...READ_ONLY, openWorldHint: false };

export const WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

export const OPEN_WRITE: ToolAnnotations = { ...WRITE, openWorldHint: true };

export const DESTRUCTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

/** Assignment/replace tools can discard existing data even without deleting it. */
export const REPLACE: ToolAnnotations = { ...DESTRUCTIVE, idempotentHint: true };
