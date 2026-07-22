import { afterEach, describe, expect, it } from "vitest";
import { createOpenRouterStub } from "../stubs/src/openrouter-stub";
import type { StubHandle } from "../stubs/src/stub-server";

// In-process contract test for the OpenRouter stub. The centerpiece is the async
// video-job state machine (design-delta §7 workflow 8): submit -> 202 pending,
// poll pending -> in_progress -> completed, content download — plus the
// idempotency the DBOS submit step relies on to survive crash/replay without
// re-issuing a job id, and the browser-side PKCE key exchange (§6a).
describe("openrouter stub", () => {
  let stub: StubHandle;

  afterEach(async () => {
    if (stub) await stub.close();
  });

  it("exchanges a PKCE code + verifier for an API key", async () => {
    stub = await createOpenRouterStub();
    const url = `${stub.baseUrl}/api/v1/auth/keys`;

    const missing = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "abc" }),
    });
    expect(missing.status).toBe(400);

    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "abc", code_verifier: "verifier" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).key).toMatch(/^sk-or-/);
    expect(stub.calls().state.keysIssued).toBe(1);
  });

  it("progresses an async video job pending -> in_progress -> completed", async () => {
    stub = await createOpenRouterStub({ pollsToComplete: 2 });

    const submit = await fetch(`${stub.baseUrl}/api/v1/videos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "stub/video", prompt: "a shelter" }),
    });
    expect(submit.status).toBe(202);
    const job = await submit.json();
    expect(job.status).toBe("pending");
    expect(job.id).toBeTypeOf("string");
    expect(job.polling_url).toContain(job.id);

    // content not available before completion
    const early = await fetch(
      `${stub.baseUrl}/api/v1/videos/${job.id}/content?index=0`,
    );
    expect(early.status).toBe(409);

    const poll1 = await fetch(`${stub.baseUrl}/api/v1/videos/${job.id}`);
    expect((await poll1.json()).status).toBe("in_progress");

    const poll2 = await fetch(`${stub.baseUrl}/api/v1/videos/${job.id}`);
    expect((await poll2.json()).status).toBe("completed");

    const content = await fetch(
      `${stub.baseUrl}/api/v1/videos/${job.id}/content?index=0`,
    );
    expect(content.status).toBe(200);
    const body = await content.json();
    expect(Array.isArray(body.unsigned_urls)).toBe(true);
    expect(body.unsigned_urls.length).toBeGreaterThan(0);
  });

  it("is idempotent on Idempotency-Key — one job across duplicate submits", async () => {
    stub = await createOpenRouterStub();
    const url = `${stub.baseUrl}/api/v1/videos`;
    const init = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "gen_abc",
      },
      body: JSON.stringify({ model: "stub/video", prompt: "a shelter" }),
    };

    const first = await (await fetch(url, init)).json();
    const second = await (await fetch(url, init)).json();

    expect(second.id).toBe(first.id);
    const calls = stub.calls();
    expect(calls.byRoute["POST /api/v1/videos"]).toBe(2);
    expect(calls.state.videoJobsCreated).toBe(1);
  });

  it("json_schema chat completions default to {stub:true} when no script is programmed", async () => {
    stub = await createOpenRouterStub();
    const res = await fetch(`${stub.baseUrl}/api/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "stub/text-model",
        response_format: { type: "json_schema" },
      }),
    });
    expect(JSON.parse((await res.json()).choices[0].message.content)).toEqual({
      stub: true,
    });
  });

  it("shifts a programmed chat-script per call (Task #30 — drives retry/repair sequences)", async () => {
    stub = await createOpenRouterStub();
    const program = await fetch(`${stub.baseUrl}/__admin/chat-script`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        responses: [
          { status: 503 },
          { status: 200, body: { scenes: [{ name: "s1" }] } },
        ],
      }),
    });
    expect((await program.json()).queued).toBe(2);

    const chat = () =>
      fetch(`${stub.baseUrl}/api/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ response_format: { type: "json_schema" } }),
      });

    const first = await chat();
    expect(first.status).toBe(503); // a transient failure the DBOS step retries

    const second = await chat();
    expect(second.status).toBe(200);
    expect(JSON.parse((await second.json()).choices[0].message.content)).toEqual({
      scenes: [{ name: "s1" }],
    });

    // Every chat call counts (including the scripted 503), and the queue is drained.
    expect(stub.calls().state.chatCompletions).toBe(2);
    const third = await chat();
    expect(JSON.parse((await third.json()).choices[0].message.content)).toEqual({
      stub: true,
    });
  });

  it("returns raw audio bytes for TTS, not JSON", async () => {
    stub = await createOpenRouterStub();
    const res = await fetch(`${stub.baseUrl}/api/v1/audio/speech`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "stub/tts", input: "hello", voice: "alloy" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("audio/mpeg");
    expect(res.headers.get("x-generation-id")).toMatch(/^gen_/);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(0);
  });

  it("shifts a programmed speech-script per call — a non-2xx drives a retry (Task #33)", async () => {
    stub = await createOpenRouterStub();
    const program = await fetch(`${stub.baseUrl}/__admin/speech-script`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ responses: [{ status: 503 }] }),
    });
    expect(program.status).toBe(200);

    // First call honors the scripted 503 (transient → MEDIA_RETRY in the workflow).
    const first = await fetch(`${stub.baseUrl}/api/v1/audio/speech`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "stub/speech-model", input: "x" }),
    });
    expect(first.status).toBe(503);

    // Second call (empty queue) falls back to the default 200 raw-mp3 response.
    const second = await fetch(`${stub.baseUrl}/api/v1/audio/speech`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "stub/speech-model", input: "x" }),
    });
    expect(second.status).toBe(200);
    expect(second.headers.get("content-type")).toContain("audio/mpeg");
    expect(stub.calls().state.speechRequests).toBe(2);
  });

  it("generates an image URL + serves the bytes (Task #32)", async () => {
    stub = await createOpenRouterStub();
    const res = await fetch(`${stub.baseUrl}/api/v1/images/generations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "stub/image-model", prompt: "a sunrise" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const url = body.data[0].url as string;
    expect(url).toContain("/api/v1/images/download/");
    expect(stub.calls().state.imageRequests).toBe(1);

    // The returned URL serves raw PNG bytes (what fetchAssetBytes downloads).
    const download = await fetch(url);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toContain("image/png");
    const bytes = new Uint8Array(await download.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(0);
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("proxies a credit balance", async () => {
    stub = await createOpenRouterStub();
    const res = await fetch(`${stub.baseUrl}/api/v1/credits`);
    expect(res.status).toBe(200);
    expect((await res.json()).data.total_credits).toBeTypeOf("number");
  });

  it("filters model discovery by output_modalities (ids resolved, never hardcoded)", async () => {
    stub = await createOpenRouterStub();

    const all = await fetch(`${stub.baseUrl}/api/v1/models`);
    expect((await all.json()).data.map((m: { id: string }) => m.id)).toEqual([
      "stub/text-model",
      "stub/speech-model",
    ]);

    const text = await fetch(
      `${stub.baseUrl}/api/v1/models?output_modalities=text`,
    );
    expect((await text.json()).data.map((m: { id: string }) => m.id)).toEqual([
      "stub/text-model",
    ]);

    const audio = await fetch(
      `${stub.baseUrl}/api/v1/models?output_modalities=audio`,
    );
    expect((await audio.json()).data.map((m: { id: string }) => m.id)).toEqual([
      "stub/speech-model",
    ]);
  });
});
