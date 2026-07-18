import { afterEach, describe, expect, it } from "vitest";
import { createGithubStub } from "../stubs/src/github-stub";
import type { StubHandle } from "../stubs/src/stub-server";

// In-process contract test for the GitHub App stub. Covers BOTH flows the design
// requires (design-delta §2.3): the installation-token path (App JWT ->
// installation token, verify installation, PR open/merge) and the JIT
// zero-storage user-token hop (code -> user token -> create repo -> add to
// installation). Real listening server, real fetch — the house style.
describe("github stub", () => {
  let stub: StubHandle;

  afterEach(async () => {
    if (stub) await stub.close();
  });

  it("verifies an installation", async () => {
    stub = await createGithubStub();
    const res = await fetch(`${stub.baseUrl}/app/installations/42`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(42);
    expect(body.account.login).toBeTypeOf("string");
    expect(["all", "selected"]).toContain(body.repository_selection);
  });

  it("requires an App JWT to mint an installation token, then mints one", async () => {
    stub = await createGithubStub();
    const url = `${stub.baseUrl}/app/installations/42/access_tokens`;

    const unauthed = await fetch(url, { method: "POST" });
    expect(unauthed.status).toBe(401);

    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: "Bearer app.jwt.token" },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.token).toMatch(/^ghs_/);
    expect(body.expires_at).toBeTypeOf("string");
    expect(stub.calls().state.installationTokensIssued).toBe(1);
  });

  it("exchanges a user-authorization code for a short-lived user token", async () => {
    stub = await createGithubStub();
    const url = `${stub.baseUrl}/login/oauth/access_token`;

    const missing = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: "x" }),
    });
    expect(missing.status).toBe(400);

    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: "x", client_secret: "y", code: "abc" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.access_token).toMatch(/^ghu_/);
  });

  it("creates a repo only with a user token and returns a git-server clone_url", async () => {
    stub = await createGithubStub({ gitServerInternalUrl: "http://git-server:8080" });
    const url = `${stub.baseUrl}/user/repos`;

    const unauthed = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "demo" }),
    });
    expect(unauthed.status).toBe(401);

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "token ghu_stub_user_1",
      },
      body: JSON.stringify({ name: "demo", private: true }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.full_name).toBe("acme/demo");
    expect(body.default_branch).toBe("main");
    expect(body.clone_url).toBe("http://git-server:8080/acme/demo.git");
    expect(stub.calls().state.reposCreated).toBe(1);
  });

  it("adds a repo to a selected installation (user token)", async () => {
    stub = await createGithubStub();
    const res = await fetch(
      `${stub.baseUrl}/user/installations/42/repositories/777`,
      { method: "PUT", headers: { authorization: "token ghu_stub_user_1" } },
    );
    expect(res.status).toBe(204);
  });

  it("opens a PR then merges it, rejecting a double-merge", async () => {
    stub = await createGithubStub();

    const opened = await fetch(`${stub.baseUrl}/repos/acme/demo/pulls`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "token ghs_stub",
      },
      body: JSON.stringify({ title: "v0.0.0 base", head: "v0.0.0", base: "main" }),
    });
    expect(opened.status).toBe(201);
    const pr = await opened.json();
    expect(pr.number).toBe(1);
    expect(pr.state).toBe("open");

    const mergeUrl = `${stub.baseUrl}/repos/acme/demo/pulls/${pr.number}/merge`;
    const merged = await fetch(mergeUrl, { method: "PUT" });
    expect(merged.status).toBe(200);
    expect((await merged.json()).merged).toBe(true);

    const again = await fetch(mergeUrl, { method: "PUT" });
    expect(again.status).toBe(405);
  });

  it("records call counts keyed by route template", async () => {
    stub = await createGithubStub();
    await fetch(`${stub.baseUrl}/app/installations/1`);
    await fetch(`${stub.baseUrl}/app/installations/2`);

    const calls = stub.calls();
    expect(calls.byRoute["GET /app/installations/:installationId"]).toBe(2);
    expect(calls.total).toBe(2);
  });
});
