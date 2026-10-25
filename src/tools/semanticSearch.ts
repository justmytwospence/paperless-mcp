import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { LINK_GUIDANCE } from "../api/documentLinks.js";
import type { SemanticSearch } from "../search/search.js";
import { jsonResult, READ_ONLY, registerTool } from "./utils/register.js";

export function registerSemanticSearchTools(server: McpServer, search: Promise<SemanticSearch>) {
  registerTool(
    server,
    "semantic_search",
    "Find documents by meaning: describe a topic, method, question or idea in your own words and get the most relevant " +
      "documents, each with the passages that matched. Use this first for topical or conceptual questions (\"papers on " +
      "variational inference for hierarchical models\", \"the warranty for the dishwasher\"), where the documents may not " +
      "use your exact words; use query_documents for exact phrases, titles, or structured filters. Results combine a " +
      "vector index of every document's full text, metadata and notes with Paperless's keyword search (hybrid: true). " +
      "Passages are excerpts: read more with get_document_content using a passage's offset. " +
      "'index' reports coverage; while it is still building, a missing document may just not be indexed yet." +
      LINK_GUIDANCE,
    {
      query: z.string().min(1).describe("What you are looking for, in natural language."),
      limit: z.number().int().min(1).max(50).optional().describe("Documents to return (default 10)."),
      hybrid: z
        .boolean()
        .optional()
        .describe("Fuse with Paperless keyword search (default true). false for purely semantic ranking."),
      passages_per_document: z
        .number()
        .int()
        .min(0)
        .max(5)
        .optional()
        .describe("Best-matching passages to include per document (default 2, 0 for none)."),
      passage_chars: z
        .number()
        .int()
        .min(100)
        .max(4000)
        .optional()
        .describe("Truncate each passage to this many characters (default 600)."),
      tag_ids: z.array(z.number().int()).optional().describe("Only documents with all of these tags."),
      correspondent_id: z.number().int().optional(),
      document_type_id: z.number().int().optional(),
      created_after: z.string().optional().describe("YYYY-MM-DD, inclusive."),
      created_before: z.string().optional().describe("YYYY-MM-DD, inclusive."),
    },
    READ_ONLY,
    async (args) => jsonResult(await (await search).search(args))
  );
}
