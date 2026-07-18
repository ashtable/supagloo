import { beforeAll, describe, expect, it } from "vitest";
import { PROVIDERS } from "../support/dev-config";

// Harness self-test: the CONTAINERIZED OpenRouter stub over a real host port.
// Proves PKCE key exchange, the async video-job state machine, and the
// idempotency the video workflow's submit step relies on across DBOS replay.
const BASE = PROVIDERS.openrouterBaseUrl;

describe("e2e: openrouter stub (containerized)", () => {
  beforeAll(async () => {
    await fetch(`${BASE}/__stub/reset`, { method: "POST" });
  });

  it("exchanges a PKCE code for a key", async () => {
    const res = await fetch(`${BASE}/api/v1/auth/keys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "c", code_verifier: "v" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).key).toMatch(/^sk-or-/);
  });

  it("runs a video job through pending -> in_progress -> completed", async () => {
    const submit = await fetch(`${BASE}/api/v1/videos`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-stub-polls-to-complete": "2",
      },
      body: JSON.stringify({ model: "stub/video", prompt: "a shelter" }),
    });
    expect(submit.status).toBe(202);
    const job = await submit.json();
    expect(job.status).toBe("pending");

    const s1 = await (await fetch(`${BASE}/api/v1/videos/${job.id}`)).json();
    expect(s1.status).toBe("in_progress");
    const s2 = await (await fetch(`${BASE}/api/v1/videos/${job.id}`)).json();
    expect(s2.status).toBe("completed");

    const content = await fetch(
      `${BASE}/api/v1/videos/${job.id}/content?index=0`,
    );
    expect(content.status).toBe(200);
    expect((await content.json()).unsigned_urls.length).toBeGreaterThan(0);
  });

  it("re-submitting with the same Idempotency-Key creates no new job", async () => {
    const init = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "gen_e2e",
      },
      body: JSON.stringify({ model: "stub/video", prompt: "same" }),
    };
    const a = await (await fetch(`${BASE}/api/v1/videos`, init)).json();
    const b = await (await fetch(`${BASE}/api/v1/videos`, init)).json();
    expect(b.id).toBe(a.id);
  });
});
