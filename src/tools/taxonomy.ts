import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { PaperlessAPI } from "../api/PaperlessAPI.js";
import { enhanceMatchingAlgorithm, enhanceMatchingAlgorithmArray } from "../api/utils.js";
import { matchingAlgorithmSchema } from "./utils/matchingAlgorithm.js";
import { buildQueryString } from "./utils/queryString.js";
import { jsonResult, READ_ONLY, registerTool, WRITE } from "./utils/register.js";

const LIST_SHAPE = {
  page: z.number().optional(),
  page_size: z.number().optional(),
  name__icontains: z.string().optional(),
  name__iendswith: z.string().optional(),
  name__iexact: z.string().optional(),
  name__istartswith: z.string().optional(),
  ordering: z.string().optional(),
};

const CACHE_HINT =
  " Fetch the whole list once (large page_size), keep it for the session, and match names locally before further calls.";

const color = z
  .string()
  .regex(/^#[0-9A-Fa-f]{6}$/)
  .optional();

// Taxonomy is add-and-rename only: deleting a tag, correspondent or type strips it
// from every document, so this server does not offer it.
export function registerTaxonomyTools(
  server: McpServer,
  api: PaperlessAPI,
  opts: { scoped?: boolean } = {}
) {
  registerTool(
    server,
    "list_tags",
    "List tags (id, name, color, matching rule, document_count)." + CACHE_HINT,
    LIST_SHAPE,
    READ_ONLY,
    async (args) => {
      const res = await api.getTags(buildQueryString(args) || undefined);
      return jsonResult({ ...res, results: enhanceMatchingAlgorithmArray(res.results || []) });
    }
  );

  registerTool(
    server,
    "create_tag",
    "Create a tag, optionally with a color and an automatic matching rule.",
    {
      name: z.string(),
      color,
      match: z.string().optional(),
      matching_algorithm: matchingAlgorithmSchema.optional(),
    },
    WRITE,
    async (args) => jsonResult(enhanceMatchingAlgorithm(await api.createTag(args)))
  );

  registerTool(
    server,
    "update_tag",
    "Rename a tag or change its color or matching rule. Omitted fields are left unchanged.",
    {
      id: z.number(),
      name: z.string().optional(),
      color,
      match: z.string().optional(),
      matching_algorithm: matchingAlgorithmSchema.optional(),
    },
    WRITE,
    async ({ id, ...data }) => jsonResult(enhanceMatchingAlgorithm(await api.updateTag(id, data)))
  );

  registerTool(
    server,
    "list_correspondents",
    "List correspondents: the people and organisations documents come from (for papers, usually the publisher or journal)." +
      CACHE_HINT,
    LIST_SHAPE,
    READ_ONLY,
    async (args) => {
      const res = await api.getCorrespondents(buildQueryString(args) || undefined);
      return jsonResult({ ...res, results: enhanceMatchingAlgorithmArray(res.results || []) });
    }
  );

  registerTool(
    server,
    "create_correspondent",
    "Create a correspondent, optionally with an automatic matching rule.",
    {
      name: z.string(),
      match: z.string().optional(),
      matching_algorithm: matchingAlgorithmSchema.optional(),
    },
    WRITE,
    async (args) => jsonResult(enhanceMatchingAlgorithm(await api.createCorrespondent(args)))
  );

  registerTool(
    server,
    "list_document_types",
    "List document types (e.g. Paper, Book, Invoice); on a scoped server, only its own." + CACHE_HINT,
    LIST_SHAPE,
    READ_ONLY,
    async (args) => {
      const res = await api.getDocumentTypes(buildQueryString(args) || undefined);
      const scope = await api.scopeTypeIds();
      const results = (res.results || []).filter((t) => !scope || scope.includes(t.id));
      return jsonResult({
        ...res,
        ...(scope ? { count: results.length, next: null, previous: null } : {}),
        results: enhanceMatchingAlgorithmArray(results),
      });
    }
  );

  // A scoped server cannot use a new type: it would be outside its own scope.
  if (!opts.scoped) {
    registerTool(
      server,
      "create_document_type",
      "Create a document type, optionally with an automatic matching rule.",
      {
        name: z.string(),
        match: z.string().optional(),
        matching_algorithm: matchingAlgorithmSchema.optional(),
      },
      WRITE,
      async (args) => jsonResult(enhanceMatchingAlgorithm(await api.createDocumentType(args)))
    );
  }

  registerTool(
    server,
    "list_custom_fields",
    "List custom fields (id, name, data_type, and for select fields the option labels in extra_data). " +
      "Use the ids with update_document, bulk_edit_documents and custom_field_query." +
      CACHE_HINT,
    LIST_SHAPE,
    READ_ONLY,
    async (args) => jsonResult(await api.getCustomFields(buildQueryString(args) || undefined))
  );
}
