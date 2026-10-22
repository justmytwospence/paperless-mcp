import { test } from "node:test";
import assert from "node:assert/strict";
import { documentUrl, setPublicUrl } from "./documentLinks";

test("document links use the public URL and reject non-ids", () => {
  setPublicUrl("https://paperless.example.test/");
  assert.equal(documentUrl(123), "https://paperless.example.test/documents/123/details");
  assert.equal(documentUrl(undefined), null);
  assert.equal(documentUrl(0), null);
  assert.equal(documentUrl("123"), null);
  assert.equal(documentUrl(1.5), null);
});
