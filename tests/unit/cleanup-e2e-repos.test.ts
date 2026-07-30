import { describe, expect, it } from "vitest";
import { E2E_REPO_PREFIX } from "../support/e2e-github-naming.mjs";
import {
  actOnRepo,
  chunk,
  confirmBatch,
  describeCandidate,
  newSummary,
  parseArgs,
  runCleanup,
  selectCandidates,
} from "../../scripts/cleanup-e2e-repos.mjs";

// Task 62 / §11 (D22, plan §5). The cleanup script is a USER-FACING DELIVERABLE that
// mutates repos in `ashtable` — a PERSONAL account holding the user's real repos. Its
// safety properties are therefore unit-tested, with BOTH the network call and the
// interactive confirmation injected, so this suite needs no network and no TTY.
//
// The properties under test are the ones the user mandated:
//   * batched review — one screen of repos confirmed as a unit, Enter meaning YES
//   * the prefix check is a HARD GATE re-checked at the MUTATION SITE, so a repo that
//     fails it is never actioned EVEN IF its batch was accepted
//   * --archive still archives and never deletes
//
// The action became DELETE by default on 2026-07-29 (507 throwaway repos vs 385 real
// ones; archived repos still page, and the pile was rate-limiting the create-repo e2e).
// That makes the mutation-site gate the ONLY thing standing between a mis-listed row and
// an irreversible loss, so it is tested harder than when the action was reversible —
// including the case where the user accepts a batch that contains a non-prefixed repo.

interface Recorded {
  url: string;
  method: string;
  body?: string;
}

function makeFetch(
  pages: Array<{ repos: unknown[]; next?: string }>,
  opts: { patchStatus?: number; deleteStatus?: number } = {},
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
    if (method === "DELETE") {
      return new Response(null, { status: opts.deleteStatus ?? 204 });
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

describe("chunk / parseArgs — batching", () => {
  it("batches in fixed sizes, preserving order, with 10 as the default", () => {
    const items = Array.from({ length: 23 }, (_, i) => i);
    expect(chunk(items, 10).map((b) => b.length)).toEqual([10, 10, 3]);
    expect(chunk(items, 10)[1][0]).toBe(10);
    expect(chunk(items, undefined).map((b) => b.length)).toEqual([10, 10, 3]);
  });

  it("defaults to DELETE in batches of 10, and --archive opts back into the reversible action", () => {
    expect(parseArgs([])).toMatchObject({ mode: "delete", batch: 10, dryRun: false });
    expect(parseArgs(["--archive"])).toMatchObject({ mode: "archive" });
    expect(parseArgs(["--batch", "25"])).toMatchObject({ batch: 25 });
    expect(parseArgs(["--batch=25"])).toMatchObject({ batch: 25 });
    expect(() => parseArgs(["--batch", "0"])).toThrow(/positive integer/);
    expect(() => parseArgs(["--yes-to-all"])).toThrow(/Unknown argument/);
  });
});

describe("confirmBatch — Enter means YES", () => {
  const batch = [repo(`${E2E_REPO_PREFIX}a-k3f9a2`), repo(`${E2E_REPO_PREFIX}b-k3f9a2`)];

  it("treats an EMPTY answer as acceptance (the requested default)", async () => {
    const { prompt, asked } = scriptedPrompt([""]);
    expect(await confirmBatch({ batch, index: 1, total: 1, prompt, log: silent })).toBe("yes");
    // The prompt must SHOW the default, or "just hit enter" is folklore rather than UI.
    expect(asked[0]).toContain("[Y/n/q]");
    expect(asked[0]).toContain("DELETE");
  });

  it("accepts y/yes, skips on n, and quits on q", async () => {
    for (const answer of ["y", "yes", "  Y  "]) {
      const { prompt } = scriptedPrompt([answer]);
      expect(await confirmBatch({ batch, index: 1, total: 1, prompt, log: silent })).toBe("yes");
    }
    for (const answer of ["n", "no", "anything else"]) {
      const { prompt } = scriptedPrompt([answer]);
      expect(await confirmBatch({ batch, index: 1, total: 1, prompt, log: silent })).toBe("skip");
    }
    for (const answer of ["q", "quit"]) {
      const { prompt } = scriptedPrompt([answer]);
      expect(await confirmBatch({ batch, index: 1, total: 1, prompt, log: silent })).toBe("quit");
    }
  });

  it("prints every repo in the batch BEFORE asking — the review is the safety property", async () => {
    const lines: string[] = [];
    const { prompt } = scriptedPrompt([""]);
    await confirmBatch({
      batch,
      index: 1,
      total: 1,
      prompt,
      log: (m: string) => lines.push(String(m)),
    });
    const printed = lines.join("\n");
    for (const r of batch) expect(printed).toContain(r.full_name);
  });

  it("names ARCHIVE rather than DELETE under --archive", async () => {
    const { prompt, asked } = scriptedPrompt([""]);
    await confirmBatch({ batch, index: 1, total: 1, mode: "archive", prompt, log: silent });
    expect(asked[0]).toContain("ARCHIVE");
    expect(asked[0]).not.toContain("DELETE");
  });
});

describe("actOnRepo — THE MUTATION-SITE GATE", () => {
  it("REFUSES a non-prefixed repo, even though its batch was accepted", async () => {
    const { fetchImpl, calls } = makeFetch([{ repos: [] }]);
    const summary = newSummary();
    await actOnRepo({
      repo: repo("supagloo-nextjs"),
      pat: "t",
      fetchImpl,
      sleepImpl: noSleep,
      log: silent,
      summary,
    });
    expect(summary.refusedByGate).toBe(1);
    expect(summary.deleted).toBe(0);
    // The decisive assertion: no request of ANY kind was made for it.
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("DELETEs a prefixed repo, at its own URL", async () => {
    const { fetchImpl, calls } = makeFetch([{ repos: [] }]);
    const summary = newSummary();
    const name = `${E2E_REPO_PREFIX}render-k3f9a2`;
    await actOnRepo({ repo: repo(name), pat: "t", fetchImpl, sleepImpl: noSleep, log: silent, summary });
    expect(summary.deleted).toBe(1);
    const dels = calls.filter((c) => c.method === "DELETE");
    expect(dels).toHaveLength(1);
    expect(dels[0].url).toBe(`https://api.github.com/repos/ashtable/${name}`);
  });

  it("archives instead — and issues NO DELETE — under --archive", async () => {
    const { fetchImpl, calls } = makeFetch([{ repos: [] }]);
    const summary = newSummary();
    await actOnRepo({
      repo: repo(`${E2E_REPO_PREFIX}render-k3f9a2`),
      pat: "t",
      mode: "archive",
      fetchImpl,
      sleepImpl: noSleep,
      log: silent,
      summary,
    });
    expect(summary.archived).toBe(1);
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([]);
    const patches = calls.filter((c) => c.method === "PATCH");
    expect(JSON.parse(patches[0].body ?? "{}")).toEqual({ archived: true });
  });

  it("DELETES an already-archived repo (it is exactly the backlog), but skips it under --archive", async () => {
    const archived = repo(`${E2E_REPO_PREFIX}old-k3f9a2`, { archived: true });

    const a = makeFetch([{ repos: [] }]);
    const s1 = newSummary();
    await actOnRepo({ repo: archived, pat: "t", fetchImpl: a.fetchImpl, sleepImpl: noSleep, log: silent, summary: s1 });
    expect(s1.deleted).toBe(1);

    const b = makeFetch([{ repos: [] }]);
    const s2 = newSummary();
    await actOnRepo({ repo: archived, pat: "t", mode: "archive", fetchImpl: b.fetchImpl, sleepImpl: noSleep, log: silent, summary: s2 });
    expect(s2.alreadyArchived).toBe(1);
    expect(b.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("records a failed delete without aborting the run, and names the missing scope", async () => {
    const { fetchImpl } = makeFetch([{ repos: [] }], { deleteStatus: 403 });
    const summary = newSummary();
    const lines: string[] = [];
    await actOnRepo({
      repo: repo(`${E2E_REPO_PREFIX}render-k3f9a2`),
      pat: "t",
      fetchImpl,
      sleepImpl: noSleep,
      log: (m: string) => lines.push(String(m)),
      summary,
    });
    expect(summary.failed).toBe(1);
    expect(summary.deleted).toBe(0);
    expect(lines.join("\n")).toMatch(/FAILED to delete/);
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

  it("a batch accepted with a single Enter still cannot touch a non-prefixed repo", async () => {
    const { fetchImpl, calls } = makeFetch([
      {
        repos: [
          repo("supagloo-nextjs"),
          repo("supagloo-nodejs-dbos"),
          repo(`${E2E_REPO_PREFIX}render-k3f9a2`),
        ],
      },
    ]);
    // ONE empty answer accepts the whole batch — the reflex this gate has to survive.
    const { prompt, asked } = scriptedPrompt([""]);
    const summary = await runCleanup({
      env,
      argv: [],
      fetchImpl,
      prompt,
      sleepImpl: noSleep,
      log: silent,
    });
    expect(asked).toHaveLength(1);
    // The two real repos were never candidates, so they are not even shown.
    expect(asked[0]).not.toContain("supagloo-nextjs");
    const deleted = calls.filter((c) => c.method === "DELETE").map((c) => c.url);
    expect(deleted).toEqual([
      `https://api.github.com/repos/ashtable/${E2E_REPO_PREFIX}render-k3f9a2`,
    ]);
    expect(summary.deleted).toBe(1);
  });

  it("offers already-archived repos too — under deletion they ARE the backlog", async () => {
    const { fetchImpl, calls } = makeFetch([
      {
        repos: [
          repo(`${E2E_REPO_PREFIX}old-k1a1a1`, { archived: true }),
          repo(`${E2E_REPO_PREFIX}new-k3f9a2`),
        ],
      },
    ]);
    const lines: string[] = [];
    const { prompt, asked } = scriptedPrompt([""]);
    const summary = await runCleanup({
      env,
      argv: [],
      fetchImpl,
      prompt,
      sleepImpl: noSleep,
      log: (m: string) => lines.push(String(m)),
    });
    expect(asked).toHaveLength(1);
    expect(lines.join("\n")).toContain(`${E2E_REPO_PREFIX}old-k1a1a1`);
    expect(summary.deleted).toBe(2);
    expect(summary.alreadyArchived).toBe(0);
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(2);
  });

  it("--archive still skips an already-archived repo rather than re-patching it", async () => {
    const { fetchImpl, calls } = makeFetch([
      { repos: [repo(`${E2E_REPO_PREFIX}old-k1a1a1`, { archived: true })] },
    ]);
    const { prompt } = scriptedPrompt([""]);
    const summary = await runCleanup({
      env,
      argv: ["--archive"],
      fetchImpl,
      prompt,
      sleepImpl: noSleep,
      log: silent,
    });
    expect(summary.alreadyArchived).toBe(1);
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("`n` skips a whole batch and `q` stops the run, leaving the rest untouched", async () => {
    const repos = Array.from({ length: 5 }, (_, i) => repo(`${E2E_REPO_PREFIX}r${i}-k3f9a2`));
    const skip = makeFetch([{ repos }]);
    const s1 = await runCleanup({
      env,
      argv: ["--batch", "2"],
      fetchImpl: skip.fetchImpl,
      prompt: scriptedPrompt(["n", "", ""]).prompt,
      sleepImpl: noSleep,
      log: silent,
    });
    expect(s1.skipped).toBe(2);
    expect(s1.deleted).toBe(3);

    const quit = makeFetch([{ repos }]);
    const s2 = await runCleanup({
      env,
      argv: ["--batch", "2"],
      fetchImpl: quit.fetchImpl,
      prompt: scriptedPrompt(["", "q"]).prompt,
      sleepImpl: noSleep,
      log: silent,
    });
    expect(s2.deleted).toBe(2);
    // The three it never reached are reported as skipped, not silently dropped.
    expect(s2.skipped).toBe(3);
    expect(quit.calls.filter((c) => c.method === "DELETE")).toHaveLength(2);
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

  it("tallies deleted / skipped / refused / failed across batches", async () => {
    const { fetchImpl } = makeFetch(
      [
        {
          repos: [
            repo(`${E2E_REPO_PREFIX}a-k3f9a2`),
            repo(`${E2E_REPO_PREFIX}b-k3f9a2`),
            repo(`${E2E_REPO_PREFIX}c-k3f9a2`),
            repo(`${E2E_REPO_PREFIX}d-k3f9a2`),
          ],
        },
      ],
      { deleteStatus: 403 },
    );
    const summary = await runCleanup({
      env,
      argv: ["--batch", "2"],
      fetchImpl,
      prompt: scriptedPrompt(["", "n"]).prompt,
      sleepImpl: noSleep,
      log: silent,
    });
    // batch 1 accepted but every DELETE 403s; batch 2 skipped wholesale.
    expect(summary.candidates).toBe(4);
    expect(summary.failed).toBe(2);
    expect(summary.deleted).toBe(0);
    expect(summary.skipped).toBe(2);
    expect(summary.refusedByGate).toBe(0);
  });

  it("--archive issues NO DELETE on any path (the reversible action is still reachable)", async () => {
    const { fetchImpl, calls } = makeFetch([
      {
        repos: [
          repo(`${E2E_REPO_PREFIX}a-k3f9a2`),
          repo("supagloo-nextjs"),
          repo(`${E2E_REPO_PREFIX}b-k3f9a2`, { archived: true }),
        ],
      },
    ]);
    const summary = await runCleanup({
      env,
      argv: ["--archive"],
      fetchImpl,
      prompt: scriptedPrompt([""]).prompt,
      sleepImpl: noSleep,
      log: silent,
    });
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([]);
    expect(summary.deleted).toBe(0);
    expect(summary.archived).toBe(1);
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
