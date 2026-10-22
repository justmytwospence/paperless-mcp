import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveUpload } from "./fileUpload";

test("uploads are confined to an agent folder under the root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uploads-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
  try {
    fs.mkdirSync(path.join(root, "agent-hermes"));
    fs.mkdirSync(path.join(root, "other"));
    fs.writeFileSync(path.join(root, "agent-hermes", "a.pdf"), "%PDF-");
    fs.writeFileSync(path.join(root, "agent-hermes", "empty.pdf"), "");
    fs.writeFileSync(path.join(root, "other", "b.pdf"), "%PDF-");
    fs.writeFileSync(path.join(outside, "secret"), "x");
    fs.symlinkSync(path.join(outside, "secret"), path.join(root, "agent-hermes", "link"));

    const ok = resolveUpload(root, "agent-hermes/a.pdf");
    assert.equal(ok.uploader, "agent-hermes");
    assert.equal(ok.abs, fs.realpathSync(path.join(root, "agent-hermes", "a.pdf")));

    for (const bad of [
      "/etc/passwd", "../x", "agent-hermes/../other/b.pdf", "other/b.pdf",
      "agent-hermes/link", "agent-hermes", "agent-hermes/empty.pdf", "agent-hermes/missing.pdf",
    ]) {
      assert.throws(() => resolveUpload(root, bad), Error, bad);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
