import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { PaperlessAPI, scopeAllows, type TaxonomyKind } from "../api/PaperlessAPI.js";
import type { PaginationResponse } from "../api/types.js";
import { enhanceMatchingAlgorithm, enhanceMatchingAlgorithmArray } from "../api/utils.js";
import { matchingAlgorithmSchema } from "./utils/matchingAlgorithm.js";
import { buildQueryString } from "./utils/queryString.js";
import { jsonResult, READ_ONLY, registerTool, REPLACE, WRITE } from "./utils/register.js";

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

type TaxonomyList<T> = Omit<PaginationResponse<T>, "next" | "previous"> & {
  next: string | number | null;
  previous: string | number | null;
};

const SCOPE_NOTE =
  " On a library server: only what the library's documents use (plus anything no document uses yet), and document_count counts the library's documents.";

// Paperless's own default page size.
const DEFAULT_PAGE_SIZE = 25;

/**
 * Lists one kind of taxonomy. A scoped server fetches the whole (filtered,
 * ordered) list, keeps what its library may see, and pages that itself, so
 * count, all and the pages describe the library rather than the whole Paperless.
 * next/previous are then page numbers rather than URLs.
 */
async function listTaxonomy<T extends { id: number; document_count?: number }>(
  api: PaperlessAPI,
  kind: TaxonomyKind | "document_types",
  fetch: (query?: string) => Promise<PaginationResponse<T>>,
  args: Record<string, unknown>
): Promise<TaxonomyList<T>> {
  const scope = await api.scope();
  if (!scope) return fetch(buildQueryString(args) || undefined);
  const { page, page_size, ...filters } = args as { page?: number; page_size?: number };
  const res = await fetch(buildQueryString({ ...filters, page_size: 100000 }));
  const items =
    kind === "document_types"
      ? (res.results || []).filter((t) => scopeAllows(scope, t.id))
      : await api.scopeTaxonomy(kind, res.results || []);
  const size = Math.max(1, page_size ?? DEFAULT_PAGE_SIZE);
  const n = Math.max(1, page ?? 1);
  return {
    count: items.length,
    next: n * size < items.length ? n + 1 : null,
    previous: n > 1 ? n - 1 : null,
    all: items.map((i) => i.id),
    results: items.slice((n - 1) * size, n * size),
  };
}

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
    "List tags (id, name, color, matching rule, document_count)." + SCOPE_NOTE + CACHE_HINT,
    LIST_SHAPE,
    READ_ONLY,
    async (args) => {
      const res = await listTaxonomy(api, "tags", (q) => api.getTags(q), args);
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
    "Rename a tag or replace its color or matching rule. Omitted fields are left unchanged; existing values can be overwritten for every document using this tag.",
    {
      id: z.number(),
      name: z.string().optional(),
      color,
      match: z.string().optional(),
      matching_algorithm: matchingAlgorithmSchema.optional(),
    },
    REPLACE,
    async ({ id, ...data }) => jsonResult(enhanceMatchingAlgorithm(await api.updateTag(id, data)))
  );

  registerTool(
    server,
    "list_correspondents",
    "List correspondents: the people and organisations documents come from (for papers, usually the publisher or journal)." +
      SCOPE_NOTE +
      CACHE_HINT,
    LIST_SHAPE,
    READ_ONLY,
    async (args) => {
      const res = await listTaxonomy(api, "correspondents", (q) => api.getCorrespondents(q), args);
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
      const res = await listTaxonomy(api, "document_types", (q) => api.getDocumentTypes(q), args);
      return jsonResult({ ...res, results: enhanceMatchingAlgorithmArray(res.results || []) });
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
      SCOPE_NOTE +
      CACHE_HINT,
    LIST_SHAPE,
    READ_ONLY,
    async (args) => jsonResult(await listTaxonomy(api, "custom_fields", (q) => api.getCustomFields(q), args))
  );
}
