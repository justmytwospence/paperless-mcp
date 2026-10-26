import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { convertDocsWithNames } from "../api/documentEnhancer.js";
import { PaperlessAPI } from "../api/PaperlessAPI.js";
import { documentUrl, LINK_GUIDANCE } from "../api/documentLinks.js";
import { arrayNotEmpty } from "./utils/empty.js";
import {
  BuildDocumentQueryArgs,
  buildDocumentQueryString,
  LIST_DOCUMENTS_ARGS_SHAPE,
  QUERY_DOCUMENTS_ARGS_SHAPE,
} from "./utils/documentQuery.js";
import { DESTRUCTIVE, LOCAL_READ_ONLY, READ_ONLY, registerTool, REPLACE } from "./utils/register.js";
import { validateCustomFields } from "./utils/monetary.js";
import { resolveSelectCustomFieldValues } from "./utils/selectFields.js";
import { CUSTOM_FIELD_VALUE_DESCRIPTION } from "./utils/descriptions.js";
import {
  buildDocumentResourceUri,
  buildThumbnailResourceUri,
} from "./utils/resourceUri.js";

export type BulkCustomFieldValue = string | number | boolean | number[] | null;

export type BulkCustomFieldUpdate = {
  field: number;
  value: BulkCustomFieldValue;
};

export type BulkCustomFieldParameters = {
  add_custom_fields?: Record<string, BulkCustomFieldValue>;
  remove_custom_fields?: number[];
};

/**
 * Builds Paperless-NGX bulk edit parameters from base parameters plus optional
 * custom field updates.
 *
 * Paperless-NGX expects custom field bulk updates as an `add_custom_fields`
 * record keyed by custom field id. `addCustomFields` is accepted as an array for
 * the MCP tool schema and transformed into that id-to-value record while
 * preserving supported value types, including `number[]` document links and
 * `null` resets. Passing an empty `addCustomFields` array intentionally produces
 * an empty `add_custom_fields` record.
 *
 * When `includeCustomFieldDefaults` is true, the function also initializes
 * `add_custom_fields` and `remove_custom_fields` with empty defaults using
 * nullish coalescing (`??=`). This keeps the `modify_custom_fields` method's
 * payload shape acceptable to Paperless even when no field values are supplied.
 *
 * @param parameters - Base bulk edit parameters to include in the result.
 * @param addCustomFields - Optional custom field updates to map by field id.
 * @param includeCustomFieldDefaults - Whether to include empty custom field
 * defaults required by `modify_custom_fields`.
 * @returns The merged API parameters with custom field updates transformed into
 * Paperless-NGX's `add_custom_fields` record shape.
 */
export function buildBulkEditParameters<T extends Record<string, unknown>>(
  parameters: T,
  addCustomFields?: BulkCustomFieldUpdate[],
  includeCustomFieldDefaults = false,
  includeTagDefaults = false
): T & BulkCustomFieldParameters {
  const apiParameters: T & BulkCustomFieldParameters = {
    ...parameters,
  };

  if (addCustomFields) {
    apiParameters.add_custom_fields = Object.fromEntries(
      addCustomFields.map((customField) => [
        String(customField.field),
        customField.value,
      ])
    );
  }

  if (includeCustomFieldDefaults) {
    apiParameters.add_custom_fields ??= {};
    apiParameters.remove_custom_fields ??= [];
  }

  if (includeTagDefaults) {
    (apiParameters as Record<string, unknown>).add_tags ??= [];
    (apiParameters as Record<string, unknown>).remove_tags ??= [];
  }

  return apiParameters;
}

/**
 * Parses a page list for delete_pages, which Paperless takes as a list of page
 * numbers (split, by contrast, takes the string itself). Accepts "2", "2,4-6"
 * and a JSON list such as "[2, 4]".
 */
export function parsePageList(pages: string): number[] {
  const text = pages.trim();
  const invalid = () =>
    new Error(`Invalid pages "${pages}": use page numbers and ranges, e.g. "2" or "2,4-6".`);
  if (text.startsWith("[")) {
    let list: unknown;
    try {
      list = JSON.parse(text);
    } catch {
      throw invalid();
    }
    if (!Array.isArray(list) || !list.length || !list.every((n) => Number.isInteger(n) && n >= 1)) {
      throw invalid();
    }
    return [...new Set(list as number[])].sort((a, b) => a - b);
  }
  const out = new Set<number>();
  for (const group of text.split(",")) {
    const m = group.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) throw invalid();
    const first = Number(m[1]);
    const last = m[2] === undefined ? first : Number(m[2]);
    // Bounded so a typo cannot build an enormous list.
    if (first < 1 || last < first || last - first > 10_000) throw invalid();
    for (let p = first; p <= last; p++) out.add(p);
  }
  if (!out.size) throw invalid();
  return [...out].sort((a, b) => a - b);
}

async function executeDocumentQuery(
  api: PaperlessAPI,
  args: BuildDocumentQueryArgs
) {
  const docsResponse = await api.getDocuments(buildDocumentQueryString(args));
  return convertDocsWithNames(docsResponse, api);
}

export function registerDocumentTools(server: McpServer, api: PaperlessAPI) {
  registerTool(
    server,
    "bulk_edit_documents",
    "Perform bulk operations on multiple documents: set correspondent/type/storage path, add/remove/modify tags (removing a tag only affects these documents), modify custom fields, reprocess, set permissions, merge, split, rotate, delete pages. Documents cannot be deleted through this server. ⚠️ delete_pages, and merge or split with delete_originals, discard content and require confirm: true.",
    {
      documents: z.array(z.number()),
      method: z.enum([
        "set_correspondent",
        "set_document_type",
        "set_storage_path",
        "add_tag",
        "remove_tag",
        "modify_tags",
        "modify_custom_fields",
        "reprocess",
        "set_permissions",
        "merge",
        "split",
        "rotate",
        "delete_pages",
      ]),
      correspondent: z.number().optional(),
      document_type: z.number().optional(),
      storage_path: z.number().optional(),
      tag: z.number().optional(),
      add_tags: z.array(z.number()).optional().transform(arrayNotEmpty),
      remove_tags: z.array(z.number()).optional().transform(arrayNotEmpty),
      add_custom_fields: z
        .array(
          z.object({
            field: z.number(),
            value: z.union([
              z.string(),
              z.number(),
              z.boolean(),
              z.array(z.number()),
              z.null(),
            ]).describe(CUSTOM_FIELD_VALUE_DESCRIPTION),
          })
        )
        .optional()
        .transform(arrayNotEmpty),
      remove_custom_fields: z
        .array(z.number())
        .optional()
        .transform(arrayNotEmpty),
      set_permissions: z
        .object({
          view: z
            .object({
              users: z.array(z.number()).optional(),
              groups: z.array(z.number()).optional(),
            })
            .strict()
            .optional(),
          change: z
            .object({
              users: z.array(z.number()).optional(),
              groups: z.array(z.number()).optional(),
            })
            .strict()
            .optional(),
        })
        // strict: a misspelled action ("read") must not silently collapse
        // into {} and clear permissions/ownership.
        .strict()
        .optional()
        .describe(
          "For set_permissions: view/change permissions to apply. Omitted actions (view/change) and omitted users/groups lists are left untouched; an empty list [] removes all (unless merge is true). Omit entirely for owner-only changes."
        ),
      owner: z
        .number()
        .int()
        .nullable()
        .optional()
        .describe(
          "For set_permissions: new owner user ID, or null to remove the owner. Unless merge is true, omitting owner also clears the current owner."
        ),
      merge: z
        .boolean()
        .optional()
        .describe(
          "For set_permissions: true adds to existing permissions and keeps the current owner; false (default) replaces the listed users/groups"
        ),
      metadata_document_id: z.number().optional(),
      delete_originals: z.boolean().optional(),
      pages: z
        .string()
        .optional()
        .describe(
          "For split: page groups, one new document per group, e.g. '1-2,3-5'. For delete_pages: the pages to remove, e.g. '2' or '2,4-6'."
        ),
      degrees: z.number().optional(),
      confirm: z
        .boolean()
        .optional()
        .describe(
          "Must be true for delete_pages, or when delete_originals is true"
        ),
    },
    DESTRUCTIVE,
    async (args) => {
      if ((args.method === "delete_pages" || args.delete_originals) && !args.confirm) {
        throw new Error(
          "Confirmation required for destructive operation. Set confirm: true to proceed."
        );
      }
      if (
        args.method === "set_permissions" &&
        !args.set_permissions &&
        args.owner === undefined
      ) {
        throw new Error(
          "Method 'set_permissions' requires set_permissions and/or owner."
        );
      }
      const { documents, method, add_custom_fields, confirm, ...parameters } = args;
      if (method === "delete_pages") {
        if (!args.pages) throw new Error("delete_pages needs pages, e.g. '2' or '2,4-6'.");
        (parameters as Record<string, unknown>).pages = parsePageList(args.pages);
      }
      if (method === "set_permissions") {
        // Paperless rejects (Paperless <= 3.0.5: crashes with a 500 on) a missing
        // set_permissions key even for owner-only changes.
        parameters.set_permissions ??= {};
      }

      validateCustomFields(add_custom_fields);
      const resolvedCustomFields = await resolveSelectCustomFieldValues(
        api,
        add_custom_fields,
        "stored"
      );

      const response = await api.bulkEditDocuments(
        documents,
        method,
        buildBulkEditParameters(
          parameters,
          resolvedCustomFields,
          method === "modify_custom_fields",
          method === "modify_tags"
        )
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ result: response.result || response }),
          },
        ],
      };
    }
  );

  registerTool(
    server,
    "list_documents",
    "List and filter documents with pagination and common Paperless filters such as title search, correspondent, document type, tag, storage path, creation date, archive serial number, and simple custom field filters. Use 'query_documents' for full-text query, structured custom field conditions, or advanced documented /api/documents/ query parameters. IMPORTANT: For queries like 'the last 3 contributions' or when searching by tag, correspondent, document type, or storage path, first use the relevant lookup tool to find the correct ID. Note: Document content is excluded from results by default. Use 'get_document_content' when you need the document text." + LINK_GUIDANCE,
    LIST_DOCUMENTS_ARGS_SHAPE,
    READ_ONLY,
    async (args) => {
      return executeDocumentQuery(api, args);
    }
  );

  registerTool(
    server,
    "query_documents",
    "Query documents using the full-text query engine plus structured Paperless filters. Use this for complex filtering, custom field conditions, or any documented /api/documents/ query parameters that are not exposed as first-class arguments. Prefer the dedicated top-level arguments where available. custom_field_query supports [field_name_or_id, operator, value] leaves or ['AND'|'OR', [clause1, clause2]] groups. Note: Document content is excluded from results by default. Use 'get_document_content' when you need the document text." + LINK_GUIDANCE,
    QUERY_DOCUMENTS_ARGS_SHAPE,
    READ_ONLY,
    async (args) => {
      return executeDocumentQuery(api, args);
    }
  );

  registerTool(
    server,
    "get_document",
    "Get a specific document by ID with full details including correspondent, document type, tags, and custom fields. Note: Document content is excluded from results by default. Use 'get_document_content' to retrieve content when needed." + LINK_GUIDANCE,
    {
      id: z.number().int().positive(),
    },
    READ_ONLY,
    async (args) => {
      const doc = await api.getDocument(args.id);
      return convertDocsWithNames(doc, api);
    }
  );

  registerTool(
    server,
    "get_document_content",
    "Get the text content of a specific document by ID. Use this when you need to read or analyze the actual document text." + LINK_GUIDANCE,
    {
      id: z.number().int().positive(),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Character offset to start from (default 0). semantic_search passages report theirs."),
      max_chars: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Return at most this many characters (default: all). Long books can be read in slices."),
    },
    READ_ONLY,
    async (args) => {
      const doc = await api.getDocument(args.id);
      const full = doc.content || "";
      const start = Math.min(args.offset ?? 0, full.length);
      const end = args.max_chars ? Math.min(full.length, start + args.max_chars) : full.length;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              id: doc.id,
              title: doc.title,
              web_url: documentUrl(doc.id),
              total_chars: full.length,
              offset: start,
              content: full.slice(start, end),
            }),
          },
        ],
      };
    }
  );

  registerTool(
    server,
    "download_document",
    "Download a document file by ID. Returns a paperless:// resource URI; read the resource to fetch the file content.",
    {
      id: z.number().int().positive(),
      original: z.boolean().optional(),
    },
    LOCAL_READ_ONLY,
    async (args) => {
      const uri = buildDocumentResourceUri(args.id, {
        original: args.original,
      });
      return {
        content: [
          // Legacy clients surface only content[].text and drop resource blocks
          // entirely, so the URI is repeated here to stay reachable (issue #134).
          { type: "text", text: uri },
          {
            type: "resource",
            resource: {
              uri,
              // MCP SDK 1.11 embedded resources require text or blob. Keep the
              // existing resource-shaped tool result while making resources/read
              // the canonical place for the large binary payload.
              text: "",
              mimeType: "application/octet-stream",
            },
          },
        ],
      };
    }
  );

  registerTool(
    server,
    "get_document_thumbnail",
    "Get a document thumbnail (image preview) by ID. Returns a paperless:// resource URI; read the resource to fetch the image content.",
    {
      id: z.number().int().positive(),
    },
    LOCAL_READ_ONLY,
    async (args) => {
      const uri = buildThumbnailResourceUri(args.id);
      return {
        content: [
          // See download_document above: the URI is repeated as text for legacy
          // clients that drop resource blocks.
          { type: "text", text: uri },
          {
            type: "resource",
            resource: {
              uri,
              // See download_document above: the binary thumbnail is fetched
              // lazily through resources/read instead of embedded here.
              text: "",
              mimeType: "image/webp",
            },
          },
        ],
      };
    }
  );

  registerTool(
    server,
    "update_document",
    "Update a specific document with new values (title, correspondent, document type, storage path, tags, custom fields, and more). Can overwrite content, ownership and filing metadata. Omitted top-level fields stay unchanged; supplied tags and custom_fields replace their entire sets. Review current values before writing; use bulk modify_custom_fields for additive field edits.",
    {
      id: z.number().int().positive().describe("The ID of the document to update"),
      title: z
        .string()
        .max(128)
        .optional()
        .describe("The new title for the document (max 128 characters)"),
      correspondent: z
        .number()
        .int()
        .nullable()
        .optional()
        .describe("The ID of the correspondent to assign"),
      document_type: z
        .number()
        .int()
        .nullable()
        .optional()
        .describe("The ID of the document type to assign"),
      storage_path: z
        .number()
        .int()
        .nullable()
        .optional()
        .describe("The ID of the storage path to assign"),
      tags: z
        .array(z.number())
        .optional()
        .describe("Array of tag IDs to assign to the document"),
      content: z
        .string()
        .optional()
        .describe("The raw text content of the document (used for searching)"),
      created: z
        .string()
        .optional()
        .describe("The creation date in YYYY-MM-DD format"),
      archive_serial_number: z
        .number()
        .optional()
        .describe("The archive serial number (0-4294967295)"),
      owner: z
        .number()
        .int()
        .nullable()
        .optional()
        .describe("The ID of the user who owns the document"),
      custom_fields: z
        .array(
          z.object({
            field: z.number().describe("The custom field ID"),
            value: z
              .union([
                z.string(),
                z.number(),
                z.boolean(),
                z.array(z.number()),
                z.null(),
              ])
              .describe(CUSTOM_FIELD_VALUE_DESCRIPTION),
          })
        )
        .optional()
        .describe(
          "Custom field values for the document. ⚠️ REPLACES the document's entire custom-field set — any field not included here will be CLEARED. To update or add a single field without losing the others, first call get_document to read the existing custom_fields, then pass the full merged array. To add/set fields additively without fetching, use bulk_edit_documents with method 'modify_custom_fields' instead."
        ),
    },
    REPLACE,
    async (args) => {
      const { id, ...updateData } = args;

      validateCustomFields(updateData.custom_fields);
      updateData.custom_fields = await resolveSelectCustomFieldValues(
        api,
        updateData.custom_fields,
        "stored"
      );

      const response = await api.updateDocument(id, updateData);

      return convertDocsWithNames(response, api);
    }
  );
}
