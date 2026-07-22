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
