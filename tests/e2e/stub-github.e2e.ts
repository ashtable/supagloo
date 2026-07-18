import { beforeAll, describe, expect, it } from "vitest";
import { PROVIDERS } from "../support/dev-config";

// Harness self-test: the CONTAINERIZED GitHub stub honors its own contract over
// a real host-published port. NOT an API<->stub integration test (that's tasks
// 10/17+). globalSetup guarantees the overlay's github-stub service is up.
const BASE = PROVIDERS.githubBaseUrl;

describe("e2e: github stub (containerized)", () => {
  beforeAll(async () => {
    await fetch(`${BASE}/__stub/reset`, { method: "POST" });
  });

  it("mints an installation token only with an App JWT", async () => {
    const url = `${BASE}/app/installations/42/access_tokens`;
    expect((await fetch(url, { method: "POST" })).status).toBe(401);

    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: "Bearer app.jwt" },
    });
    expect(res.status).toBe(201);
    expect((await res.json()).token).toMatch(/^ghs_/);
  });

  it("opens and merges a pull request", async () => {
    const opened = await fetch(`${BASE}/repos/acme/demo/pulls`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "publish", head: "v0.0.1", base: "main" }),
    });
    expect(opened.status).toBe(201);
    const pr = await opened.json();

    const merged = await fetch(
      `${BASE}/repos/acme/demo/pulls/${pr.number}/merge`,
      { method: "PUT" },
    );
    expect(merged.status).toBe(200);
    expect((await merged.json()).merged).toBe(true);
  });

  it("exposes call counts via /__stub/calls", async () => {
    const calls = await (await fetch(`${BASE}/__stub/calls`)).json();
    expect(calls.total).toBeGreaterThan(0);
    expect(calls.state.installationTokensIssued).toBeGreaterThanOrEqual(1);
  });
});
