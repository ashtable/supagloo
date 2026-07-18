import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROVIDERS } from "../support/dev-config";

// Harness self-test: a REAL git clone/commit/push/merge/tag cycle against the
// containerized local git smart-HTTP server, driven by the host `git` CLI over a
// published host port. This is the git half of the git-ops flows (scaffold /
// commit / publish, design-delta §7); the "PR open/merge" REST half lives on the
// github stub. Proves the smart-HTTP backend serves upload-pack AND receive-pack
// for arbitrary semver branch names.
const BASE = PROVIDERS.gitServerBaseUrl;
const REPO = `acme/demo-${Date.now()}`;
const CLONE_URL = `${BASE}/${REPO}.git`;

let scratch: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Supagloo Test",
      GIT_AUTHOR_EMAIL: "test@supagloo.local",
      GIT_COMMITTER_NAME: "Supagloo Test",
      GIT_COMMITTER_EMAIL: "test@supagloo.local",
    },
  }).trim();
}

describe("e2e: local git smart-HTTP server (containerized)", () => {
  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), "supagloo-git-"));
    await fetch(`${BASE}/__stub/reset`, { method: "POST" });
    const res = await fetch(`${BASE}/__admin/repos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: REPO, seed: true, defaultBranch: "main" }),
    });
    expect(res.status).toBe(201);
  });

  afterAll(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  it("clones, branches, commits, pushes, merges and tags", () => {
    const work = join(scratch, "work");
    git(scratch, "clone", CLONE_URL, work);

    // A working version branch with a new commit (mirrors cutWorkingBranch).
    git(work, "checkout", "-b", "v0.0.1");
    execFileSync("bash", ["-c", `printf 'scene' > "${join(work, "scene.txt")}"`]);
    git(work, "add", "-A");
    git(work, "commit", "-m", "add scene");
    git(work, "push", "origin", "refs/heads/v0.0.1");

    // Integrate to main (the merged-PR result) and cut a tag (publish).
    git(work, "checkout", "main");
    git(work, "merge", "--no-ff", "v0.0.1", "-m", "merge v0.0.1");
    git(work, "push", "origin", "refs/heads/main");
    git(work, "tag", "v0.0.1");
    git(work, "push", "origin", "refs/tags/v0.0.1");

    // Fresh clone proves the pushed state is durable server-side.
    const verify = join(scratch, "verify");
    git(scratch, "clone", CLONE_URL, verify);
    expect(git(verify, "ls-tree", "-r", "--name-only", "main")).toContain(
      "scene.txt",
    );
    expect(git(verify, "tag", "-l")).toContain("v0.0.1");
  });

  it("recorded upload-pack and receive-pack traffic", async () => {
    const calls = await (await fetch(`${BASE}/__stub/calls`)).json();
    expect(calls.state.uploadPackRequests).toBeGreaterThan(0);
    expect(calls.state.receivePackRequests).toBeGreaterThan(0);
  });
});
