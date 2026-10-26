import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { MAX_BINARY_BYTES, PaperlessAPI } from "./PaperlessAPI.js";
import { RequestPolicy } from "./requestPolicy.js";
import { FakeClock, settle } from "../test/fakeClock.js";
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
const apiWith = (policy: RequestPolicy) => new PaperlessAPI("http://p.test", "fake", { requestPolicy: policy });

for (const [header, delay] of [["2", 2000], ["Wed, 01 Jan 2025 00:00:03 GMT", 3000], [null, 1000], ["invalid", 1000]] as const) {
  test(`safe 429 read retry honors ${header ?? "missing Retry-After"} with a fake clock and exact accounting`, async () => {
    const clock = new FakeClock();
    const policy = new RequestPolicy({ clock });
    let calls = 0;
    globalThis.fetch = async () => ++calls === 1 ? json({}, 429, header ? { "retry-after": header } : {}) : json({ ok: true });
    const result = apiWith(policy).getDocuments();
    await settle();
    assert.equal(calls, 1);
    assert.equal(policy.status().queued, 1);
    assert.equal(policy.status().read_retries, 0);
    await clock.advance(delay - 1);
    assert.equal(calls, 1);
    await clock.advance(1);
    assert.deepEqual(await result, { ok: true });
    assert.equal(calls, 2);
    assert.equal(policy.status().attempts, 2);
    assert.equal(policy.status().read_retries, 1);
    assert.equal(policy.status().last_429_at, "2025-01-01T00:00:00.000Z");
    assert.equal(policy.status().upstream_quota, null);
    assert.equal(policy.status().cooldown_until, null);
    assert.equal(clock.timers.size, 0);
  });
}

test("a repeated 429 stops at two attempts; long cooldown rejects admission without claiming quota", async () => {
  const clock = new FakeClock();
  const policy = new RequestPolicy({ clock });
  let calls = 0;
  globalThis.fetch = async () => { calls++; return json({}, 429, { "retry-after": calls === 1 ? "1" : "120" }); };
  const result = assert.rejects(apiWith(policy).getDocuments(), /429/);
  await settle();
  await clock.advance(1000);
  await result;
  assert.equal(calls, 2);
  const status = policy.status();
  assert.equal(status.cooldown_until, "2025-01-01T00:02:01.000Z");
  assert.equal(status.attempts, 2);
  await assert.rejects(apiWith(policy).getDocuments(), /cooldown exceeds/);
  assert.equal(calls, 2);
  assert.equal(policy.status().upstream_quota, null);
  assert.equal(clock.timers.size, 0);
});

test("one shared bound covers libraries, JSON bodies, binary bodies and multipart uploads; queue is bounded", async () => {
  const clock = new FakeClock();
  const policy = new RequestPolicy({ clock, concurrency: 2, maxQueue: 1 });
  const pending: Array<() => void> = [];
  const paths: string[] = [];
  globalThis.fetch = (async (input: string | URL) => {
    paths.push(new URL(String(input)).pathname);
    return new Response(new ReadableStream({ start(controller) {
      // Keeping the response body open must keep the admission slot too.
      pending.push(() => { controller.enqueue(new TextEncoder().encode('"ok"')); controller.close(); });
    } }));
  }) as typeof fetch;
  const a = apiWith(policy), b = apiWith(policy);
  const first = a.getDocuments();
  const binary = b.getThumbnail(1);
  await settle();
  const upload = b.postDocument(Buffer.from("%PDF-"), "a.pdf");
  await settle();
  assert.equal(policy.status().active, 2);
  assert.equal(policy.status().queued, 1);
  assert.equal(paths.length, 2);
  await assert.rejects(a.getDocuments(), /queue is full/);
  pending.shift()!();
  await first;
  await settle();
  assert.equal(paths.length, 3);
  assert.ok(paths.includes("/api/documents/post_document/"));
  assert.equal(policy.status().active, 2);
  pending.shift()!();
  pending.shift()!();
  assert.equal((await binary).data.toString(), '"ok"');
  assert.equal(await upload, "ok");
  assert.equal(policy.status().active, 0);
  assert.equal(policy.status().attempts, 3);
  assert.equal(clock.timers.size, 0);
});

test("queued admission expires with zero attempts and frees capacity", async () => {
  const clock = new FakeClock();
  const policy = new RequestPolicy({ clock, concurrency: 1, timeoutMs: 10_000, queueTimeoutMs: 1000 });
  let finish!: () => void;
  const active = policy.run("GET", () => new Promise<void>((r) => { finish = r; }));
  await settle();
  const queued = assert.rejects(policy.run("GET", async () => assert.fail("no call")), /admission timed out/);
  await clock.advance(1000);
  await queued;
  assert.equal(policy.status().attempts, 1);
  assert.equal(policy.status().queued, 0);
  finish(); await active;
  assert.equal(clock.timers.size, 0);
});

for (const kind of ["json", "binary", "upload", "patch"] as const) {
  test(`${kind} has a body-inclusive timeout and never replays ambiguous failures`, async () => {
    const clock = new FakeClock();
    const policy = new RequestPolicy({ clock, timeoutMs: 1000 });
    const api = apiWith(policy);
    let calls = 0;
    globalThis.fetch = (async (_input: string | URL, init: RequestInit) => {
      calls++;
      return new Response(new ReadableStream({ start(controller) {
        init.signal!.addEventListener("abort", () => controller.error(new Error("aborted body")), { once: true });
      } }));
    }) as typeof fetch;
    const call = kind === "json" ? api.getDocuments() : kind === "binary" ? api.downloadDocument(1) :
      kind === "upload" ? api.postDocument(Buffer.from("%PDF-"), "a.pdf") : api.updateDocument(1, { title: "new" });
    const rejected = assert.rejects(call, kind === "upload" || kind === "patch" ? /outcome may be unknown/ : /Read was not retried/);
    await settle();
    await clock.advance(999);
    assert.equal(policy.status().active, 1);
    await clock.advance(1);
    await rejected;
    assert.equal(calls, 1);
    assert.equal(policy.status().active, 0);
    assert.equal(policy.status().read_retries, 0);
    assert.equal(clock.timers.size, 0);
  });
}

test("binary reads safely retry 429, but multipart/patch writes and network/5xx failures never replay", async () => {
  const clock = new FakeClock();
  const policy = new RequestPolicy({ clock });
  let calls = 0;
  globalThis.fetch = async () => ++calls === 1 ? json({}, 429, { "retry-after": "1" }) : new Response("bytes");
  const result = apiWith(policy).downloadDocument(1);
  await settle(); await clock.advance(1000);
  assert.equal((await result).data.toString(), "bytes");
  assert.equal(calls, 2);
  for (const kind of ["upload", "patch", "network", "5xx"] as const) {
    let attempts = 0;
    const p = new RequestPolicy({ clock });
    const api = apiWith(p);
    globalThis.fetch = async () => {
      attempts++;
      if (kind === "network") throw new TypeError("connection lost");
      return json({ detail: "failed" }, kind === "5xx" ? 503 : 429, { "retry-after": "2" });
    };
    await assert.rejects(kind === "upload" ? api.postDocument(Buffer.from("%PDF-"), "a.pdf") : kind === "patch" ? api.updateDocument(1, { title: "new" }) : api.getDocuments());
    assert.equal(attempts, 1, kind);
    assert.equal(p.status().read_retries, 0);
  }
});

test("Paperless redirects cannot silently replay writes or multipart uploads", async () => {
  for (const kind of ["json", "binary", "patch", "upload"] as const) {
    const api = apiWith(new RequestPolicy());
    let calls = 0;
    globalThis.fetch = async (_url, init) => {
      calls++;
      assert.equal(init?.redirect, "error", "native fetch must not follow/replay a 307/308");
      throw new TypeError("redirect rejected");
    };
    await assert.rejects(kind === "json" ? api.getDocuments() : kind === "binary" ? api.downloadDocument(1) :
      kind === "patch" ? api.updateDocument(1, { title: "new" }) : api.postDocument(Buffer.from("%PDF-"), "a.pdf"), /redirect rejected/);
    assert.equal(calls, 1, kind);
  }
});

test("a write's 429 is not replayed and its observed cooldown delays other libraries", async () => {
  const clock = new FakeClock();
  const policy = new RequestPolicy({ clock });
  let calls = 0;
  globalThis.fetch = async () => ++calls === 1 ? json({}, 429, { "retry-after": "2" }) : json({ results: [] });
  await assert.rejects(apiWith(policy).postDocument(Buffer.from("%PDF-"), "a.pdf"), /429/);
  const otherLibrary = apiWith(policy).getDocuments();
  await settle();
  assert.equal(calls, 1);
  assert.equal(policy.status().queued, 1);
  await clock.advance(1999);
  assert.equal(calls, 1);
  await clock.advance(1);
  await otherLibrary;
  assert.equal(calls, 2);
  assert.equal(policy.status().read_retries, 0, "new read after cooldown is not a retry");
  assert.equal(clock.timers.size, 0);
});

test("binary output is capped by declared size and streamed size; policy releases slots", async () => {
  const api = apiWith(new RequestPolicy());
  globalThis.fetch = async () => new Response("small", { headers: { "content-length": String(MAX_BINARY_BYTES + 1) } });
  await assert.rejects(api.downloadDocument(1), /exceeds 16 MiB/);
  globalThis.fetch = async () => new Response(new Uint8Array(MAX_BINARY_BYTES + 1));
  await assert.rejects(api.downloadDocument(1), /exceeds 16 MiB/);
  assert.equal(api.requestPolicy.status().active, 0);
});

test("invalid local policy is rejected rather than creating unbounded admission", () => {
  for (const options of [{ concurrency: 0 }, { maxQueue: -1 }, { timeoutMs: Infinity }, { queueTimeoutMs: 1.5 }, { timeoutMs: 2_147_483_648 }]) {
    assert.throws(() => new RequestPolicy(options), /Invalid request policy/);
  }
});
