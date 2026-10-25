import type { CallToolResult, McpServer, ToolAnnotations } from "@modelcontextprotocol/server";
import { z } from "zod";

type Shape = z.ZodRawShape;

/**
 * Registers a tool from a raw zod shape. Errors become a JSON message carrying the
 * Paperless status and body, which is what a calling agent needs to correct itself.
 */
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
    { description, inputSchema: z.object(shape), annotations },
    (async (args: z.infer<z.ZodObject<S>>) => {
      try {
        return await handler(args);
      } catch (err) {
        const e = err as { message?: string; status?: number; responseData?: unknown };
        throw new Error(
          JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
            responseData: e?.responseData,
            status: e?.status,
          })
        );
      }
    }) as any
  );
}

export function jsonResult(value: unknown, pretty = false): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, pretty ? 2 : undefined) }],
  };
}

export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export const WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

export const OPEN_WRITE: ToolAnnotations = { ...WRITE, openWorldHint: true };

export const DESTRUCTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
