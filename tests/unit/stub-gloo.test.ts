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

  it("serves chat-completions only with a bearer token", async () => {
    stub = await createGlooStub();
    const url = `${stub.baseUrl}/ai/v2/chat-completions`;

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
});
