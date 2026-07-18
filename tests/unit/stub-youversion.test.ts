import { afterEach, describe, expect, it } from "vitest";
import { createYouVersionStub } from "../stubs/src/youversion-stub";
import type { StubHandle } from "../stubs/src/stub-server";

// In-process contract test for the YouVersion Data Exchange stub. The whole point
// is the KJV/BSB-only constraint (memory kjv-bsb-generation-only / design-delta
// §9-Q10): the collection endpoint resolves version ids at runtime and exposes
// ONLY KJV + BSB; the passage endpoint refuses any other translation.
describe("youversion stub", () => {
  let stub: StubHandle;

  afterEach(async () => {
    if (stub) await stub.close();
  });

  it("lists ONLY KJV and BSB in the bible collection", async () => {
    stub = await createYouVersionStub();
    const res = await fetch(`${stub.baseUrl}/data-exchange/v1/bibles`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.data.map((b: { id: string }) => b.id).sort();
    expect(ids).toEqual(["bsb", "kjv"]);
    for (const bible of body.data) {
      expect(bible.public_domain).toBe(true);
    }
  });

  it("serves KJV passage text from a fixture", async () => {
    stub = await createYouVersionStub();
    const res = await fetch(
      `${stub.baseUrl}/data-exchange/v1/passages?version=kjv&reference=${encodeURIComponent(
        "John 3:16",
      )}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.version).toBe("KJV");
    expect(body.reference).toBe("John 3:16");
    expect(body.passages[0].text.length).toBeGreaterThan(0);
    expect(stub.calls().state.passageFetches).toBe(1);
  });

  it("serves BSB passage text from a fixture", async () => {
    stub = await createYouVersionStub();
    const res = await fetch(
      `${stub.baseUrl}/data-exchange/v1/passages?version=bsb&reference=${encodeURIComponent(
        "Psalm 121:1-2",
      )}`,
    );
    expect(res.status).toBe(200);
    expect((await res.json()).version).toBe("BSB");
  });

  it("rejects a non-public-domain translation", async () => {
    stub = await createYouVersionStub();
    const res = await fetch(
      `${stub.baseUrl}/data-exchange/v1/passages?version=niv&reference=${encodeURIComponent(
        "John 3:16",
      )}`,
    );
    expect(res.status).toBe(400);
  });

  it("404s an unknown reference", async () => {
    stub = await createYouVersionStub();
    const res = await fetch(
      `${stub.baseUrl}/data-exchange/v1/passages?version=kjv&reference=${encodeURIComponent(
        "Nahum 1:1",
      )}`,
    );
    expect(res.status).toBe(404);
  });

  // --- Task #10: auth token-verification / userinfo endpoint -----------------
  // Invented contract (scratch/auth-and-sessions.md §0): the API verifies a
  // forwarded YouVersion access token by GET /auth/v1/userinfo (bearer), which
  // returns a userinfo payload the API maps onto the User model.
  it("GET /auth/v1/userinfo returns the Ada fixture for a valid access token", async () => {
    stub = await createYouVersionStub();
    const res = await fetch(`${stub.baseUrl}/auth/v1/userinfo`, {
      headers: { authorization: "Bearer yv-access-ada" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("yv-user-1001");
    expect(body.first_name).toBe("Ada");
    expect(body.last_name).toBe("Lovelace");
    expect(body.email).toContain("@");
    expect(stub.calls().state.userinfoOk).toBe(1);
  });

  it("GET /auth/v1/userinfo 401s an invalid or missing access token", async () => {
    stub = await createYouVersionStub();
    const invalid = await fetch(`${stub.baseUrl}/auth/v1/userinfo`, {
      headers: { authorization: "Bearer yv-access-invalid" },
    });
    expect(invalid.status).toBe(401);
    expect((await invalid.json()).error).toBe("invalid_token");

    const missing = await fetch(`${stub.baseUrl}/auth/v1/userinfo`);
    expect(missing.status).toBe(401);
    expect(stub.calls().state.userinfoRejected).toBe(2);
  });

  it("GET /auth/v1/userinfo derives a stable user for an arbitrary token", async () => {
    stub = await createYouVersionStub();
    const res = await fetch(`${stub.baseUrl}/auth/v1/userinfo`, {
      headers: { authorization: "Bearer run-42" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("yv_run-42");
    // Same token ⇒ same derived user (drives the create-vs-update branch).
    const again = await fetch(`${stub.baseUrl}/auth/v1/userinfo`, {
      headers: { authorization: "Bearer run-42" },
    });
    expect((await again.json()).id).toBe("yv_run-42");
  });
});
