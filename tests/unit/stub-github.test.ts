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

  it("requires an App JWT to verify an installation, then returns it", async () => {
    stub = await createGithubStub();

    // Real GitHub 401s GET /app/installations/:id without an App JWT (Task #11:
    // the stub now enforces it so the callback e2e proves the API signs one).
    const unauthed = await fetch(`${stub.baseUrl}/app/installations/42`);
    expect(unauthed.status).toBe(401);

    const res = await fetch(`${stub.baseUrl}/app/installations/42`, {
      headers: { authorization: "Bearer app.jwt.token" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(42);
    expect(body.account.login).toBeTypeOf("string");
    expect(["all", "selected"]).toContain(body.repository_selection);
  });

  it("lists installation repositories only with an installation token", async () => {
    stub = await createGithubStub();
    const url = `${stub.baseUrl}/installation/repositories`;

    const unauthed = await fetch(url);
    expect(unauthed.status).toBe(401);

    const res = await fetch(url, {
      headers: { authorization: "token ghs_stub_inst_42_1" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.repositories)).toBe(true);
    expect(body.repositories.length).toBeGreaterThan(1);

    // A repo object carries enough to derive `empty` (size 0) and to search.
    const empties = body.repositories.filter((r: any) => r.size === 0);
    const nonEmpties = body.repositories.filter((r: any) => r.size > 0);
    expect(empties.length).toBeGreaterThan(0);
    expect(nonEmpties.length).toBeGreaterThan(0);
    for (const r of body.repositories) {
      expect(r.full_name).toBeTypeOf("string");
      expect(r.owner.login).toBeTypeOf("string");
    }

    // `state.reposListed` counts only AUTHORIZED listings (1); `byRoute` counts
    // every request to the template — the unauthed 401 + the authed 200 = 2.
    expect(stub.calls().state.reposListed).toBe(1);
    expect(
      stub.calls().byRoute["GET /installation/repositories"],
    ).toBe(2);
  });

  it("paginates /installation/repositories via page/per_page and a Link: rel=\"next\" header", async () => {
    // Real GitHub paginates this endpoint. The stub must too, or the API client's
    // single-fetch truncation bug stays invisible: with per_page=2 over the
    // 4-repo fixture there are two pages, and only page 1 carries `rel="next"`.
    stub = await createGithubStub();
    const auth = { authorization: "token ghs_stub_inst_42_1" };

    const p1 = await fetch(
      `${stub.baseUrl}/installation/repositories?per_page=2&page=1`,
      { headers: auth },
    );
    expect(p1.status).toBe(200);
    const b1 = await p1.json();
    expect(b1.repositories.map((r: any) => r.id)).toEqual([101, 102]);
    expect(b1.total_count).toBe(4);

    const link1 = p1.headers.get("link");
    expect(link1).toContain('rel="next"');
    const next = link1!.match(/<([^>]+)>\s*;\s*rel="next"/)![1];
    expect(next).toContain("per_page=2");
    expect(next).toContain("page=2");

    // Page 2 is the LAST page: remaining repos, and NO `rel="next"` — the client
    // uses that absence to stop, so the union is complete and the loop ends.
    const p2 = await fetch(next, { headers: auth });
    expect(p2.status).toBe(200);
    const b2 = await p2.json();
    expect(b2.repositories.map((r: any) => r.id)).toEqual([103, 104]);
    expect(p2.headers.get("link") ?? "").not.toContain('rel="next"');

    // Union across pages == the full fixture: nothing silently dropped.
    expect(
      [...b1.repositories, ...b2.repositories].map((r: any) => r.id),
    ).toEqual([101, 102, 103, 104]);
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
