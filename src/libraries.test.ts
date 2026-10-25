import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLibraries } from "./libraries.js";

test("libraries parse with per-library index directories", () => {
  const libs = parseLibraries(
    {
      libraries: [
        { name: "papers", document_types: ["Academic"], upload_root: "/uploads/papers" },
        { name: "household", exclude_document_types: ["Academic"], semantic_search: false },
      ],
    },
    "/data"
  );
  assert.deepEqual(
    libs.map((l) => [l.name, l.documentTypes, l.excludeDocumentTypes, l.uploadRoot, l.dataDir]),
    [
      ["papers", ["Academic"], [], "/uploads/papers", "/data/papers"],
      ["household", [], ["Academic"], undefined, undefined],
    ]
  );
});

test("without a data directory no library has semantic search", () => {
  const [lib] = parseLibraries({ libraries: [{ name: "a" }] }, "");
  assert.equal(lib.dataDir, undefined);
});

test("bad library definitions are refused", () => {
  for (const bad of [
    { libraries: [] },
    { libraries: [{ name: "Bad Name" }] },
    { libraries: [{ name: "a" }, { name: "a" }] },
    { libraries: [{ name: "a", document_types: ["X"], exclude_document_types: ["Y"] }] },
    { libraries: [{ name: "a", typo_field: 1 }] },
  ]) {
    assert.throws(() => parseLibraries(bad, "/data"), Error, JSON.stringify(bad));
  }
});
