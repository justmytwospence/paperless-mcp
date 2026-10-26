import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { PaperlessAPI } from "../api/PaperlessAPI.js";
import { Note } from "../api/types.js";
import { DESTRUCTIVE, jsonResult, READ_ONLY, registerTool, WRITE } from "./utils/register.js";

function notesResult(notes: Note[]) {
  return jsonResult(notes);
}

export function registerNoteTools(server: McpServer, api: PaperlessAPI) {
  registerTool(
    server,
    "list_document_notes",
    "List all notes attached to a document. Notes are free-text comments on a document and are the natural place for an audit trail (e.g. \"invoice paid on X from account Y\") or progress notes on an action item.",
    {
      id: z.number().describe("The document ID"),
    },
    READ_ONLY,
    async (args) => {
      return notesResult(await api.getDocumentNotes(args.id));
    }
  );

  registerTool(
    server,
    "create_document_note",
    "Add a note to a document. Use this to record an audit trail or progress note directly on the document. Returns the document's full list of notes after the note is added.",
    {
      id: z.number().describe("The document ID"),
      note: z.string().min(1).describe("The note text to add"),
    },
    WRITE,
    async (args) => {
      return notesResult(await api.createDocumentNote(args.id, args.note));
    }
  );

  registerTool(
    server,
    "delete_document_note",
    "⚠️ DESTRUCTIVE: Permanently delete a single note from a document by its note ID. This operation is irreversible. Returns the document's remaining notes.",
    {
      id: z.number().describe("The document ID"),
      note_id: z.number().describe("The ID of the note to delete"),
      confirm: z
        .boolean()
        .describe("Must be true to confirm this destructive operation"),
    },
    { ...DESTRUCTIVE, idempotentHint: true },
    async (args) => {
      if (!args.confirm) {
        throw new Error(
          "Confirmation required for destructive operation. Set confirm: true to proceed."
        );
      }
      return notesResult(await api.deleteDocumentNote(args.id, args.note_id));
    }
  );
}
