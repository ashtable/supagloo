import { afterEach, describe, expect, it } from "vitest";
import { createGlooStub } from "../stubs/src/gloo-stub";
import type { StubHandle } from "../stubs/src/stub-server";

// In-process contract test for the Gloo stub — client-credentials OAuth2 token
// mint (Basic auth clientId:secret, design-delta §2.5) + the text-only
// chat-completions endpoint. Gloo has no media modalities.
describe("gloo stub", () => {
  let stub: StubHandle;

  afterEach(async () => {
    if (stub) await stub.close();
  });

  const basic = (id: string, secret: string) =>
    `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;

  it("mints a client-credentials token with Basic auth", async () => {
    stub = await createGlooStub();
    const url = `${stub.baseUrl}/oauth2/token`;

    const unauthed = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    expect(unauthed.status).toBe(401);

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: basic("client-id", "client-secret"),
      },
      body: "grant_type=client_credentials",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.access_token).toMatch(/^gloo_/);
    expect(body.token_type).toBe("Bearer");
    expect(stub.calls().state.tokensIssued).toBe(1);
  });

  it("rejects a reserved sentinel clientId as invalid_client (verify-failure seam)", async () => {
    stub = await createGlooStub();
    const url = `${stub.baseUrl}/oauth2/token`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        // Task #12: `gloo-invalid` is the deterministic bad-credential fixture the
        // API's verify-then-store e2e uses to prove a failed mint leaves no row.
        authorization: basic("gloo-invalid", "whatever"),
      },
      body: "grant_type=client_credentials",
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("invalid_client");
    // A rejected mint must not increment the issued-token counter.
    expect(stub.calls().state.tokensIssued).toBe(0);
  });

  it("serves chat-completions only with a bearer token", async () => {
    stub = await createGlooStub();
    const url = `${stub.baseUrl}/ai/v2/chat/completions`;

    const unauthed = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    expect(unauthed.status).toBe(401);

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer gloo_stub_1",
      },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.choices[0].message.content).toBeTypeOf("string");
  });

  it("returns schema-shaped JSON content for a json_schema request (generateObject path)", async () => {
    stub = await createGlooStub();
    // What the AI SDK's `createOpenAI(...).chat()` emits for generateObject: Gloo
    // honors `response_format: { type: "json_schema" }` on the /ai/v2/chat/completions
    // surface, so the stub returns parseable JSON (not prose) for that request.
    const res = await fetch(`${stub.baseUrl}/ai/v2/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer gloo_stub_1",
      },
      body: JSON.stringify({
        model: "gloo-stub-model",
        response_format: { type: "json_schema" },
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    const content = (await res.json()).choices[0].message.content;
    expect(() => JSON.parse(content)).not.toThrow();
  });
});
