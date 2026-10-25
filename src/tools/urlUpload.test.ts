import { test } from "node:test";
import assert from "node:assert/strict";
import { setPublicUrl } from "../api/documentLinks.js";
import { deriveFilename, isPublicAddress, looksLikeHtml, scopedTaskSummary, summarizeTask } from "./urlUpload.js";

const pdf = Buffer.from("%PDF-1.7\n...");

test("only globally routable addresses are public", () => {
  for (const a of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) {
    assert.equal(isPublicAddress(a), true, a);
  }
  for (const a of [
    "127.0.0.1", "10.1.2.3", "172.16.255.1", "192.168.1.1", "169.254.169.254",
    "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fc00::1", "::ffff:127.0.0.1",
    "2002:7f00:1::", "64:ff9b::7f00:1",
  ]) {
    assert.equal(isPublicAddress(a), false, a);
  }
});

test("filenames come from the argument, the header, then the URL", () => {
  assert.equal(deriveFilename("Paper.pdf", "", "https://x.test/a", pdf), "Paper.pdf");
  assert.equal(
    deriveFilename(undefined, "attachment; filename*=UTF-8''caf%C3%A9.pdf", "https://x.test/a", pdf),
    "café.pdf"
  );
  assert.equal(deriveFilename(undefined, "", "https://arxiv.org/pdf/1905.03222", pdf), "1905.03222.pdf");
  assert.equal(deriveFilename(undefined, "", "https://x.test/", Buffer.from("hi")), "document");
  assert.equal(deriveFilename("../../etc/passwd", "", "https://x.test/", Buffer.from("x")), "passwd");
});

test("HTML is recognised by header or bytes, but a PDF always wins", () => {
  assert.equal(looksLikeHtml(Buffer.from("<!DOCTYPE html><html>"), ""), true);
  assert.equal(looksLikeHtml(Buffer.from("anything"), "text/html; charset=utf-8"), true);
  assert.equal(looksLikeHtml(pdf, "text/html"), false);
});

test("task summaries report the outcome with links", () => {
  setPublicUrl("https://p.test");
  assert.deepEqual(
    summarizeTask({ task_id: "t", status: "SUCCESS", related_document: "7", result: "ok" }),
    { task_id: "t", status: "success", result: "ok", outcome: "created", document_id: 7, web_url: "https://p.test/documents/7/details" }
  );
  assert.equal(
    summarizeTask({ task_id: "t", status: "FAILURE", duplicate_documents: [{ id: 3, title: "X" }] }).outcome,
    "duplicate"
  );
  assert.equal(summarizeTask({ task_id: "t", status: "FAILURE" }).outcome, "failed");
  assert.equal(summarizeTask({ task_id: "t", status: "STARTED" }).outcome, "pending");
});

// A scoped api stub: documents 1-99 are in the library, the rest are not.
function scopedApi(started: string[] = []) {
  return {
    scope: async () => ({ include: [1], exclude: null, uploadType: 1 }),
    documentsInScope: async (ids: number[]) => new Set(ids.filter((id) => id < 100)),
    startedTask: (id: string) => started.includes(id),
  } as any;
}

test("a duplicate in another library is reported without its id or title", async () => {
  const s = await scopedTaskSummary(scopedApi(["t"]), {
    task_id: "t",
    status: "FAILURE",
    result: "Not consuming: It is a duplicate of document #1100",
    duplicate_documents: [{ id: 1100, title: "Secret lease" }],
  });
  assert.equal(s?.outcome, "duplicate");
  assert.deepEqual(s?.duplicate_of, []);
  assert.equal(s?.duplicate_outside_library, true);
  assert.doesNotMatch(JSON.stringify(s), /1100|Secret/);
});

test("a duplicate named only in the result text is still recognised and scoped", async () => {
  const s = await scopedTaskSummary(scopedApi(["t"]), {
    task_id: "t",
    status: "FAILURE",
    result: "Not consuming: It is a duplicate of document #42",
    duplicate_documents: [],
  });
  assert.equal(s?.outcome, "duplicate");
  assert.deepEqual(s?.duplicate_of?.map((d) => d.id), [42]);
});

test("another library's task is not reported; one that created a document here is", async () => {
  assert.equal(
    await scopedTaskSummary(scopedApi(), { task_id: "x", status: "SUCCESS", related_document: 500 }),
    undefined
  );
  assert.equal(await scopedTaskSummary(scopedApi(), { task_id: "x", status: "STARTED" }), undefined);
  assert.equal(
    (await scopedTaskSummary(scopedApi(), { task_id: "x", status: "SUCCESS", related_document: 5 }))?.outcome,
    "created"
  );
  assert.equal(
    (await scopedTaskSummary(scopedApi(["p"]), { task_id: "p", status: "STARTED" }))?.outcome,
    "pending"
  );
});
