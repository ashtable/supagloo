import { describe, expect, it } from "vitest";
import { PROVIDERS } from "../support/dev-config";

// Harness self-test: the CONTAINERIZED Gloo stub over a real host port —
// client-credentials token mint (Basic auth) then text chat-completions (bearer).
const BASE = PROVIDERS.glooBaseUrl;
const basic = `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`;

describe("e2e: gloo stub (containerized)", () => {
  it("mints a token then serves chat-completions", async () => {
    const token = await fetch(`${BASE}/oauth2/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: basic,
      },
      body: "grant_type=client_credentials",
    });
    expect(token.status).toBe(200);
    const { access_token } = await token.json();
    expect(access_token).toMatch(/^gloo_/);

    const chat = await fetch(`${BASE}/ai/v2/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${access_token}`,
      },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    expect(chat.status).toBe(200);
    expect((await chat.json()).choices[0].message.content).toBeTypeOf("string");
  });

  it("rejects chat-completions without a bearer token", async () => {
    const res = await fetch(`${BASE}/ai/v2/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    expect(res.status).toBe(401);
  });
});
