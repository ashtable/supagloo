import { describe, expect, it } from "vitest";
import { E2E_REPO_PREFIX } from "../support/e2e-github-naming.mjs";
import {
  confirmAndArchive,
  describeCandidate,
  newSummary,
  runCleanup,
  selectCandidates,
} from "../../scripts/cleanup-e2e-repos.mjs";

// Task 62 / §11 (D22, plan §5). The cleanup script is a USER-FACING DELIVERABLE that
// mutates repos in `ashtable` — a PERSONAL account holding the user's real repos. Its
// safety properties are therefore unit-tested, with BOTH the network call and the
// interactive confirmation injected, so this suite needs no network and no TTY.
//
// The properties under test are the ones the user mandated:
//   * ARCHIVE only — never DELETE
//   * per-repo interactive confirmation
//   * the prefix check is a HARD GATE re-checked at the MUTATION SITE, so a repo that
//     fails it is never actioned EVEN IF the user typed "yes"

interface Recorded {
  url: string;
  method: string;
  body?: string;
}

function makeFetch(
  pages: Array<{ repos: unknown[]; next?: string }>,
  opts: { patchStatus?: number } = {},
): { fetchImpl: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  let pageIndex = 0;
  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = String(init.method ?? "GET").toUpperCase();
    calls.push({
      url,
      method,
      body: typeof init.body === "string" ? init.body : undefined,
    });
    if (method === "PATCH") {
      return new Response(JSON.stringify({ archived: true }), {
        status: opts.patchStatus ?? 200,
        headers: { "content-type": "application/json" },
      });
    }
    const page = pages[Math.min(pageIndex, pages.length - 1)];
    pageIndex += 1;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (page.next) headers.link = `<${page.next}>; rel="next"`;
    return new Response(JSON.stringify(page.repos), { status: 200, headers });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function repo(name: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    full_name: `ashtable/${name}`,
    owner: { login: "ashtable" },
    private: true,
    archived: false,
    created_at: "2026-07-25T10:00:00Z",
    pushed_at: "2026-07-25T10:05:00Z",
    description: "Supagloo e2e throwaway · run k3f9a2 · safe to archive",
    ...extra,
  };
}

/** Scripted stdin: one canned answer per prompt, in order. */
function scriptedPrompt(answers: string[]) {
  const asked: string[] = [];
  return {
    asked,
    prompt: async (question: string) => {
      asked.push(question);
      return answers.shift() ?? "no";
    },
  };
}

const silent = () => {};
const noSleep = async () => {};

describe("selectCandidates — the prefix filter", () => {
  it("keeps only prefixed names and passes real repos through untouched", () => {
    const all = [
      repo("supagloo-nextjs"),
      repo("supagloo-nodejs-api"),
      repo("supagloo"),
      repo(`${E2E_REPO_PREFIX}render-k3f9a2`),
      repo(`${E2E_REPO_PREFIX}manifest-k3f9a2`),
    ];
    expect(selectCandidates(all).map((r) => r.name)).toEqual([
      `${E2E_REPO_PREFIX}render-k3f9a2`,
      `${E2E_REPO_PREFIX}manifest-k3f9a2`,
    ]);
  });
});

describe("describeCandidate — informed confirmation", () => {
  it("shows full name, visibility, dates, description and archived state", () => {
    const line = describeCandidate(repo(`${E2E_REPO_PREFIX}render-k3f9a2`));
    expect(line).toContain(`ashtable/${E2E_REPO_PREFIX}render-k3f9a2`);
    expect(line).toContain("private");
    expect(line).toContain("2026-07-25");
    expect(line).toContain("safe to archive");
  });
});

describe("confirmAndArchive — THE MUTATION-SITE GATE", () => {
  it("REFUSES a non-prefixed repo even when the user answers yes", async () => {
    // The single most important test in this file. The gate is re-checked HERE, at
    // the mutation site, so it is a code invariant rather than a filtering side
    // effect: a mis-listed row plus a mistyped `y` must be structurally incapable of
    // touching one of the user's real repos.
    const { fetchImpl, calls } = makeFetch([{ repos: [] }]);
    const summary = newSummary();
    const { prompt } = scriptedPrompt(["yes"]);
    await confirmAndArchive({
      repo: repo("supagloo-nextjs"),
      pat: "p",
      prompt,
      fetchImpl,
      sleepImpl: noSleep,
      log: silent,
      summary,
    });
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(summary.refusedByGate).toBe(1);
    expect(summary.archived).toBe(0);
  });

  it("archives a prefixed repo on yes, with PATCH {archived:true}", async () => {
    const { fetchImpl, calls } = makeFetch([{ repos: [] }]);
    const summary = newSummary();
    const { prompt } = scriptedPrompt(["y"]);
    const target = repo(`${E2E_REPO_PREFIX}render-k3f9a2`);
    await confirmAndArchive({
      repo: target,
      pat: "p",
      prompt,
      fetchImpl,
      sleepImpl: noSleep,
      log: silent,
      summary,
    });
    const patches = calls.filter((c) => c.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0].url).toBe(
      `https://api.github.com/repos/ashtable/${E2E_REPO_PREFIX}render-k3f9a2`,
    );
    expect(JSON.parse(patches[0].body ?? "{}")).toEqual({ archived: true });
    expect(summary.archived).toBe(1);
  });

  it("skips on anything that is not an affirmative answer", async () => {
    for (const answer of ["", "n", "no", "nope", "Y E S", "q"]) {
      const { fetchImpl, calls } = makeFetch([{ repos: [] }]);
      const summary = newSummary();
      const { prompt } = scriptedPrompt([answer]);
      await confirmAndArchive({
        repo: repo(`${E2E_REPO_PREFIX}render-k3f9a2`),
        pat: "p",
        prompt,
        fetchImpl,
        sleepImpl: noSleep,
        log: silent,
        summary,
      });
      expect(calls.filter((c) => c.method === "PATCH")).toEqual([]);
      expect(summary.skipped).toBe(1);
    }
  });

  it("records a failed archive without aborting the run", async () => {
    const { fetchImpl } = makeFetch([{ repos: [] }], { patchStatus: 403 });
    const summary = newSummary();
    const { prompt } = scriptedPrompt(["yes"]);
    await confirmAndArchive({
      repo: repo(`${E2E_REPO_PREFIX}render-k3f9a2`),
      pat: "p",
      prompt,
      fetchImpl,
      sleepImpl: noSleep,
      log: silent,
      summary,
    });
    expect(summary.failed).toBe(1);
    expect(summary.archived).toBe(0);
  });
});

describe("runCleanup", () => {
  const env = { GITHUB_E2E_PAT_TOKEN: "ghp_fake_for_unit_test" };

  it("follows Link rel=next when listing the account's repos", async () => {
    const { fetchImpl, calls } = makeFetch([
      {
        repos: [repo(`${E2E_REPO_PREFIX}one-k3f9a2`)],
        next: "https://api.github.com/user/repos?affiliation=owner&per_page=100&page=2",
      },
      { repos: [repo(`${E2E_REPO_PREFIX}two-k3f9a2`)] },
    ]);
    const summary = await runCleanup({
      env,
      argv: ["--dry-run"],
      fetchImpl,
      sleepImpl: noSleep,
      log: silent,
    });
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(2);
    expect(summary.candidates).toBe(2);
  });

  it("never prompts for — and never mutates — a repo that fails the prefix gate", async () => {
    const { fetchImpl, calls } = makeFetch([
      {
        repos: [
          repo("supagloo-nextjs"),
          repo("supagloo-nodejs-dbos"),
          repo(`${E2E_REPO_PREFIX}render-k3f9a2`),
        ],
      },
    ]);
    const { prompt, asked } = scriptedPrompt(["yes", "yes", "yes"]);
    const summary = await runCleanup({
      env,
      argv: [],
      fetchImpl,
      prompt,
      sleepImpl: noSleep,
      log: silent,
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain(`${E2E_REPO_PREFIX}render-k3f9a2`);
    expect(asked.join(" ")).not.toContain("supagloo-nextjs");
    const patched = calls.filter((c) => c.method === "PATCH").map((c) => c.url);
    expect(patched).toEqual([
      `https://api.github.com/repos/ashtable/${E2E_REPO_PREFIX}render-k3f9a2`,
    ]);
    expect(summary.archived).toBe(1);
  });

  it("lists and skips already-archived repos WITHOUT prompting", async () => {
    const { fetchImpl, calls } = makeFetch([
      {
        repos: [
          repo(`${E2E_REPO_PREFIX}old-k1a1a1`, { archived: true }),
          repo(`${E2E_REPO_PREFIX}new-k3f9a2`),
        ],
      },
    ]);
    const { prompt, asked } = scriptedPrompt(["yes"]);
    const summary = await runCleanup({
      env,
      argv: [],
      fetchImpl,
      prompt,
      sleepImpl: noSleep,
      log: silent,
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain(`${E2E_REPO_PREFIX}new-k3f9a2`);
    expect(summary.alreadyArchived).toBe(1);
    expect(summary.archived).toBe(1);
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
  });

  it("--dry-run lists candidates and exits: no prompts, no mutation", async () => {
    const { fetchImpl, calls } = makeFetch([
      { repos: [repo(`${E2E_REPO_PREFIX}render-k3f9a2`)] },
    ]);
    const { prompt, asked } = scriptedPrompt(["yes"]);
    const summary = await runCleanup({
      env,
      argv: ["--dry-run"],
      fetchImpl,
      prompt,
      sleepImpl: noSleep,
      log: silent,
    });
    expect(asked).toEqual([]);
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(summary.candidates).toBe(1);
    expect(summary.dryRun).toBe(true);
  });

  it("tallies archived / skipped / already-archived / refused / failed", async () => {
    const { fetchImpl } = makeFetch([
      {
        repos: [
          repo(`${E2E_REPO_PREFIX}a-k3f9a2`),
          repo(`${E2E_REPO_PREFIX}b-k3f9a2`),
          repo(`${E2E_REPO_PREFIX}c-k3f9a2`, { archived: true }),
          repo("supagloo-nextjs"),
        ],
      },
    ]);
    const { prompt } = scriptedPrompt(["yes", "no"]);
    const summary = await runCleanup({
      env,
      argv: [],
      fetchImpl,
      prompt,
      sleepImpl: noSleep,
      log: silent,
    });
    expect(summary).toMatchObject({
      candidates: 3,
      archived: 1,
      skipped: 1,
      alreadyArchived: 1,
      refusedByGate: 0,
      failed: 0,
    });
  });

  it("NEVER issues a DELETE, on any path", async () => {
    // `delete_repo` is documented in .env.example for completeness, but this script
    // must never call DELETE: archiving is reversible, deletion is not.
    const { fetchImpl, calls } = makeFetch([
      {
        repos: [
          repo(`${E2E_REPO_PREFIX}a-k3f9a2`),
          repo(`${E2E_REPO_PREFIX}b-k3f9a2`, { archived: true }),
          repo("supagloo-nextjs"),
        ],
      },
    ]);
    const { prompt } = scriptedPrompt(["yes", "yes", "yes"]);
    await runCleanup({
      env,
      argv: [],
      fetchImpl,
      prompt,
      sleepImpl: noSleep,
      log: silent,
    });
    expect(calls.map((c) => c.method)).not.toContain("DELETE");
  });

  it("fails fast, naming the var and .env.example, when the PAT is missing", async () => {
    const { fetchImpl, calls } = makeFetch([{ repos: [] }]);
    let message = "";
    try {
      await runCleanup({ env: {}, argv: [], fetchImpl, sleepImpl: noSleep, log: silent });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("GITHUB_E2E_PAT_TOKEN");
    expect(message).toContain(".env.example");
    expect(calls).toEqual([]);
  });

  it("never prints the token, or any prefix of it", async () => {
    const lines: string[] = [];
    const { fetchImpl } = makeFetch([
      { repos: [repo(`${E2E_REPO_PREFIX}render-k3f9a2`)] },
    ]);
    await runCleanup({
      env,
      argv: ["--dry-run"],
      fetchImpl,
      sleepImpl: noSleep,
      log: (...args: unknown[]) => lines.push(args.map(String).join(" ")),
    });
    const output = lines.join("\n");
    expect(output).not.toContain("ghp_");
    expect(output).not.toContain(env.GITHUB_E2E_PAT_TOKEN.slice(0, 6));
  });
});
