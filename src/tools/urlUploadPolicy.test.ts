import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { PaperlessAPI } from "../api/PaperlessAPI.js";
import { RequestPolicy } from "../api/requestPolicy.js";
import { FakeClock, settle } from "../test/fakeClock.js";
import { parseToolText, withClient } from "../test/mcp.js";
import { registerUrlUploadTools } from "./urlUpload.js";

/** Stub Node sockets as well as fetch: these tests must never connect to any host. */
function stubSource(responses: Array<PassThrough & { statusCode: number; headers: Record<string, string> }>) {
  const original = http.get;
  const urls: string[] = [];
  http.get = ((url: URL, options: { signal: AbortSignal }) => {
    urls.push(url.href);
    const req = new EventEmitter() as EventEmitter & { destroy: (err?: Error) => void };
    req.destroy = (err) => { if (err) req.emit("error", err); };
    options.signal.addEventListener("abort", () => req.destroy(new Error("aborted socket")), { once: true });
    const response = responses.shift();
    if (response) setImmediate(() => req.emit("response", response));
    return req;
  }) as typeof http.get;
  return { urls, restore: () => { http.get = original; } };
}
function response(statusCode: number, headers: Record<string, string> = {}) {
  return Object.assign(new PassThrough(), { statusCode, headers });
}

test("source redirect bodies retain aggregate admission; every hop and multipart POST is counted", async () => {
  const clock = new FakeClock();
  const policy = new RequestPolicy({ clock, concurrency: 1 });
  const api = new PaperlessAPI("http://p.test", "fake", { requestPolicy: policy });
  const redirect = response(302, { location: "http://files.example.com/final.pdf" });
  const file = response(200, { "content-type": "application/pdf" });
  const source = stubSource([redirect, file]);
  const originalFetch = globalThis.fetch;
  const methods: string[] = [];
  globalThis.fetch = async (_url, init) => {
    methods.push(init?.method ?? "GET");
    return new Response(JSON.stringify(init?.method === "POST" ? "task-123" : { results: [] }));
  };
  try {
    await withClient((server) => registerUrlUploadTools(server, api), async (client) => {
      const upload = client.callTool({ name: "post_document_from_url", arguments: { url: "http://files.example.com/start", wait_seconds: 0 } });
      await settle(); await settle();
      const concurrent = api.getDocuments();
      await settle();
      assert.equal(policy.status().active, 1);
      assert.equal(policy.status().queued, 1);
      assert.equal(source.urls.length, 1);
      assert.deepEqual(methods, [], "redirect body still owns the slot");
      redirect.end();
      await concurrent;
      await settle(); await settle();
      assert.equal(source.urls.length, 2);
      assert.deepEqual(methods, ["GET"]);
      file.end("%PDF-1.7");
      const result = await upload;
      assert.equal(result.isError, undefined);
      assert.equal(parseToolText(result).task_id, "task-123");
      assert.deepEqual(methods, ["GET", "POST"]);
      assert.equal(policy.status().attempts, 4);
      assert.equal(policy.status().active, 0);
      assert.equal(clock.timers.size, 0);
    });
  } finally { source.restore(); globalThis.fetch = originalFetch; }
});

test("source timeout aborts socket without uploading/replaying, and SSRF remains blocked before admission", async () => {
  const clock = new FakeClock();
  const policy = new RequestPolicy({ clock, timeoutMs: 1000 });
  const api = new PaperlessAPI("http://p.test", "fake", { requestPolicy: policy });
  const source = stubSource([]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => assert.fail("no Paperless request before a source is available");
  try {
    await withClient((server) => registerUrlUploadTools(server, api), async (client) => {
      const blocked = await client.callTool({ name: "post_document_from_url", arguments: { url: "http://127.0.0.1/private" } });
      assert.equal(blocked.isError, true);
      assert.equal(source.urls.length, 0);
      assert.equal(policy.status().attempts, 0);
      const upload = client.callTool({ name: "post_document_from_url", arguments: { url: "http://files.example.com/waits" } });
      await settle(); await settle();
      await clock.advance(1000);
      const failed = await upload;
      assert.equal(failed.isError, true);
      assert.match(parseToolText(failed).error, /timed out/);
      assert.deepEqual(failed.structuredContent, parseToolText(failed));
      assert.equal(source.urls.length, 1);
      assert.equal(policy.status().active, 0);
      assert.equal(policy.status().read_retries, 0);
      assert.equal(clock.timers.size, 0);
    });
  } finally { source.restore(); globalThis.fetch = originalFetch; }
});
