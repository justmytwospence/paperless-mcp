import type { McpServer } from "@modelcontextprotocol/server";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { PaperlessAPI } from "../api/PaperlessAPI.js";
import { MAX_FILE_SIZE_BYTES } from "../config.js";
import { jsonResult, registerTool, WRITE } from "./utils/register.js";
import { deriveFilename, UPLOAD_METADATA_SHAPE, uploadOutcome } from "./urlUpload.js";

// For files an agent already holds (downloads, generated reports, attachments).
// The server mounts one staging directory read-only per library (its upload root),
// with one subdirectory per agent (agent-<name>/), each writable by that agent
// only. The first path segment names the uploader, and the document is tagged
// with it, so everything an agent filed stays reviewable.

const UPLOADER = /^agent-[a-z0-9-]{1,40}$/;

export function resolveUpload(root: string, rel: string): { abs: string; uploader: string } {
  if (
    typeof rel !== "string" ||
    !rel ||
    path.isAbsolute(rel) ||
    rel.includes("\0") ||
    rel.split(/[\\/]/).includes("..")
  ) {
    throw new Error("path must be relative to the upload folder, e.g. 'agent-alice/report.pdf'.");
  }
  const rootReal = fs.realpathSync(root);
  const abs = fs.realpathSync(path.resolve(rootReal, rel));
  if (!abs.startsWith(rootReal + path.sep)) {
    throw new Error("path resolves outside the upload folder.");
  }
  const uploader = path.relative(rootReal, abs).split(path.sep)[0];
  if (!UPLOADER.test(uploader)) {
    throw new Error("the file must be inside an agent folder (agent-<name>/...).");
  }
  const st = fs.statSync(abs);
  if (!st.isFile()) {
    throw new Error(`${rel} is not a regular file.`);
  }
  if (st.size === 0) {
    throw new Error(`${rel} is empty.`);
  }
  if (st.size > MAX_FILE_SIZE_BYTES) {
    throw new Error(
      `${rel} is larger than the ${Math.round(MAX_FILE_SIZE_BYTES / 1024 / 1024)}MB upload limit.`
    );
  }
  return { abs, uploader };
}

async function tagId(api: PaperlessAPI, name: string): Promise<number> {
  const found = await api.request(`/tags/?name__iexact=${encodeURIComponent(name)}`);
  const hit = found && Array.isArray(found.results) ? found.results[0] : undefined;
  if (hit) {
    return hit.id;
  }
  const made = await api.createTag({ name, matching_algorithm: 0 });
  return made.id;
}

export function registerFileUploadTools(server: McpServer, api: PaperlessAPI, root?: string) {
  if (!root) {
    return;
  }
  registerTool(
    server,
    "post_document_from_file",
    "Add a document to Paperless from a file you already have (downloaded, generated, or an attachment). " +
      "First save the file into your own folder in this server's upload area (your instructions say where " +
      "that folder is mounted for you), then call this with 'path' relative to the upload area: " +
      "'<your agent folder>/<file name>', e.g. 'agent-alice/invoice.pdf'. For documents on the web use " +
      "post_document_from_url instead. The document is tagged with your agent folder's name. Set 'title' (and other " +
      "metadata) if you know it. Waits for Paperless to consume the file (default 30s) and reports " +
      "'created' with document_id and web_url, 'duplicate' with the existing document, 'failed', or " +
      "'pending' (check later with get_task_status). You may delete your copy afterwards.",
    {
      path: z
        .string()
        .describe("Path relative to the upload area: '<agent folder>/<file>', e.g. 'agent-alice/report.pdf'."),
      filename: z
        .string()
        .optional()
        .describe("Filename to give the upload (defaults to the file's name)."),
      ...UPLOAD_METADATA_SHAPE,
      tags: z
        .array(z.number())
        .optional()
        .describe("Tag ids, in addition to the automatic uploader tag."),
    },
    WRITE,
    async (args) => {
      const { abs, uploader } = resolveUpload(root, args.path);
      const body = fs.readFileSync(abs);
      const name = path.basename(abs);
      const filename = deriveFilename(args.filename || name, "", "file:///" + name, body);
      const { path: _p, filename: _f, wait_seconds, ...metadata } = args;
      const uploaderTag = await tagId(api, uploader);
      metadata.tags = [...new Set([...(metadata.tags || []), uploaderTag])];

      const response = await api.postDocument(body, filename, metadata, [uploaderTag]);
      const result = {
        path: args.path,
        uploader,
        filename,
        bytes: body.length,
        ...(await uploadOutcome(api, response, wait_seconds)),
      };
      return jsonResult(result, true);
    }
  );
}
