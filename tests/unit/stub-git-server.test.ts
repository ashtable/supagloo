import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGitServer } from "../stubs/src/git-server";
import type { StubHandle } from "../stubs/src/stub-server";

// In-process contract test for the git-server's ADMIN endpoint only. The
// smart-HTTP clone/push cycle can't be exercised in-process (driving the host
// `git` CLI against a same-process server deadlocks the event loop — see the
// containerized git-server.e2e.ts), but `POST /__admin/repos` is a plain JSON
// endpoint we can hit in-process to prove its input validation.
//
// Security: the `name` field is interpolated into a filesystem path, so an
// unsanitized `..` or leading `/` would let a caller create bare repos OUTSIDE
// the repos root (path traversal). These tests pin that shut.
describe("git-server POST /__admin/repos name validation", () => {
  let stub: StubHandle | undefined;
  let container: string | undefined;

  afterEach(async () => {
    if (stub) await stub.close();
    stub = undefined;
    // `container` is the parent of reposRoot, so it also captures anything a
    // traversal attempt would have created one level up — cleaned up wholesale.
    if (container) rmSync(container, { recursive: true, force: true });
    container = undefined;
  });

  async function start(): Promise<{ handle: StubHandle; reposRoot: string }> {
    container = mkdtempSync(join(tmpdir(), "supagloo-git-admin-"));
    const reposRoot = join(container, "repos");
    stub = await createGitServer({ reposRoot });
    return { handle: stub, reposRoot };
  }

  it("rejects a `..` traversal name with 400 and creates nothing outside reposRoot", async () => {
    const { handle } = await start();

    const res = await fetch(`${handle.baseUrl}/__admin/repos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "../outside/pwn", seed: false }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_name");
    // The malicious path `<reposRoot>/../outside/pwn.git` lands inside `container`;
    // nothing may have been created there.
    expect(existsSync(join(container!, "outside"))).toBe(false);
    expect(existsSync(join(container!, "outside", "pwn.git"))).toBe(false);
  });

  it("rejects a leading-slash absolute name with 400", async () => {
    const { handle } = await start();

    const res = await fetch(`${handle.baseUrl}/__admin/repos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "/etc/pwn", seed: false }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_name");
  });

  it("accepts a legitimate owner/repo name and creates it under reposRoot", async () => {
    const { handle, reposRoot } = await start();

    const res = await fetch(`${handle.baseUrl}/__admin/repos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "acme/demo-123", seed: false }),
    });

    expect(res.status).toBe(201);
    expect(existsSync(join(reposRoot, "acme", "demo-123.git"))).toBe(true);
  });
});
