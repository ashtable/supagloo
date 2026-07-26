#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import { isE2eRepoName } from "../tests/support/e2e-github-naming.mjs";
import {
  GITHUB_API_BASE,
  archiveRepo,
  listOwnerRepos,
  loadRootEnv,
} from "../tests/support/e2e-github-api.mjs";

/**
 * INTERACTIVE CLEANUP OF E2E GITHUB ARTIFACT REPOS.  Archives — never deletes.
 * ===========================================================================
 *
 *   npm run cleanup:github-e2e            # from the root repo
 *   node scripts/cleanup-e2e-repos.mjs    # equivalent
 *   node scripts/cleanup-e2e-repos.mjs --dry-run
 *   node scripts/cleanup-e2e-repos.mjs --env-file /path/to/.env
 *
 * Task 62 / design-delta §11 (D22, plan §5). Zero dependencies, plain ESM, no build
 * step — that is what makes it still work in six months.
 *
 * WHY IT IS BUILT THE WAY IT IS
 * -----------------------------
 * Every full e2e sweep leaves roughly 15-20 private throwaway repos in `ashtable`, a
 * PERSONAL account that also holds the user's REAL repos. There is deliberately NO
 * in-suite teardown (D6): you almost always need the repo to debug a red run, and an
 * automated mutation in that account is unacceptable. Reclamation is therefore a human
 * action, and this script is the ONLY lifecycle-ending path.
 *
 * The three safety properties, all unit-tested in
 * `tests/unit/cleanup-e2e-repos.test.ts` with an injected `fetch` and a scripted stdin:
 *
 *  1. ARCHIVE ONLY. `PATCH /repos/:owner/:repo {"archived": true}`. This script NEVER
 *     issues a DELETE. Archiving is reversible; deletion is not. Nothing in this
 *     project uses the `delete_repo` PAT scope, and `.env.example` tells you not to
 *     grant it — there is no hard-delete escape hatch here, by design.
 *
 *  2. PER-REPO INTERACTIVE CONFIRMATION. One prompt per repo, showing the full
 *     owner/name, visibility, dates and the stamped description so the answer is
 *     informed. There is NO `--yes-to-all`: a non-interactive fast path would defeat the
 *     review step, which is the whole point. That means it cannot run in CI — an
 *     accepted, recorded cost (**plan row 67**, which is what the provisional
 *     "row N5" in an earlier revision of this comment became; row 67 has since
 *     closed as documentation, with the accounting re-measured in design-delta
 *     §11.9 rather than the cost re-argued).
 *
 *  3. THE PREFIX IS A HARD GATE, RE-CHECKED AT THE MUTATION SITE. `isE2eRepoName` is
 *     imported from `tests/support/e2e-github-naming.mjs` — the ONE authored home of the
 *     prefix (D1) — and it is evaluated again inside `confirmAndArchive`, immediately
 *     before the PATCH. A name that fails it is NEVER actioned even if the user typed
 *     "yes". That makes the prefix a code invariant rather than a filtering side effect,
 *     so a mis-listed row plus a mistyped `y` is structurally incapable of touching a
 *     real repo.
 *
 * A token value is never printed, in whole or in part.
 */

const AFFIRMATIVE = new Set(["y", "yes"]);

export function newSummary() {
  return {
    candidates: 0,
    archived: 0,
    skipped: 0,
    alreadyArchived: 0,
    refusedByGate: 0,
    failed: 0,
    dryRun: false,
  };
}

/** Keep only repos whose name passes the hard gate. Real repos are never candidates. */
export function selectCandidates(repos) {
  return (repos ?? []).filter((r) => isE2eRepoName(r?.name));
}

/** One human-readable line per candidate, so the confirmation is informed (plan §5.4). */
export function describeCandidate(repo) {
  const fullName = repo.full_name ?? `${repo.owner?.login ?? "?"}/${repo.name}`;
  const visibility = repo.private ? "private" : "PUBLIC";
  const state = repo.archived ? "ARCHIVED" : "active";
  const created = String(repo.created_at ?? "?").slice(0, 10);
  const pushed = String(repo.pushed_at ?? "?").slice(0, 10);
  return (
    `${fullName}\n` +
    `    ${visibility} · ${state} · created ${created} · last push ${pushed}\n` +
    `    ${repo.description ?? "(no description)"}`
  );
}

/** Default prompt: real stdin via node:readline/promises. Injected in tests. */
async function defaultPrompt(question) {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/**
 * Ask about ONE repo, then act — with the prefix gate re-checked here, at the mutation
 * site. Mutates `summary` and never throws: one 403 must not abandon the rest of the run.
 */
export async function confirmAndArchive({
  repo,
  pat,
  prompt = defaultPrompt,
  fetchImpl,
  sleepImpl,
  log = console.log,
  summary,
}) {
  const owner = repo.owner?.login ?? repo.full_name?.split("/")[0];
  const name = repo.name;
  const answer = String(
    await prompt(`Archive ${owner}/${name} ? [y/N] `),
  )
    .trim()
    .toLowerCase();

  if (!AFFIRMATIVE.has(answer)) {
    summary.skipped += 1;
    log(`  skipped ${owner}/${name}`);
    return;
  }

  // THE HARD GATE, at the mutation site. Not redundant with selectCandidates: this is
  // what makes "never touch a real repo" a property of the mutating code itself.
  if (!isE2eRepoName(name)) {
    summary.refusedByGate += 1;
    log(
      `  REFUSED ${owner}/${name} — the name does not match the e2e throwaway prefix, ` +
        "so this script will not touch it (even though you answered yes).",
    );
    return;
  }

  try {
    await archiveRepo({ pat, owner, repo: name, fetchImpl, sleepImpl });
    summary.archived += 1;
    log(`  archived ${owner}/${name}`);
  } catch (err) {
    summary.failed += 1;
    log(`  FAILED to archive ${owner}/${name}: ${err instanceof Error ? err.message : err}`);
  }
}

function parseArgs(argv) {
  const out = { dryRun: false, envFile: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--env-file") out.envFile = argv[++i];
    else if (arg.startsWith("--env-file=")) out.envFile = arg.slice("--env-file=".length);
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`Unknown argument ${arg}. Supported: --dry-run, --env-file <path>.`);
  }
  return out;
}

const HELP = `cleanup-e2e-repos — interactively ARCHIVE Supagloo e2e throwaway repos.

  --dry-run           list candidates and exit (no prompts, no mutation)
  --env-file <path>   read credentials from this .env instead of <root>/.env

Requires GITHUB_E2E_PAT_TOKEN. Archives only; never deletes. There is intentionally no
--yes-to-all: each repo is confirmed individually.`;

export async function runCleanup({
  env = process.env,
  argv = process.argv.slice(2),
  fetchImpl,
  sleepImpl,
  prompt,
  log = console.log,
} = {}) {
  const args = parseArgs(argv);
  const summary = newSummary();
  summary.dryRun = args.dryRun;

  if (args.help) {
    log(HELP);
    return summary;
  }

  // Only touch the real filesystem when we were handed the real environment: a unit test
  // passing a literal env object must never load a developer's .env.
  if (env === process.env) loadRootEnv({ envFile: args.envFile });

  const pat = env.GITHUB_E2E_PAT_TOKEN;
  if (typeof pat !== "string" || pat.trim() === "") {
    throw new Error(
      "GITHUB_E2E_PAT_TOKEN is missing or blank, so there is no credential to list or archive with.\n" +
        "  Set it in the untracked root .env — the variable is documented (names only) in .env.example.\n" +
        "  It needs the classic `repo` scope: the GitHub App installation grants no `administration`, " +
        "so an installation token can neither create nor archive a repository.",
    );
  }

  log("Listing repos owned by the PAT's account…");
  const all = await listOwnerRepos({ pat: pat.trim(), fetchImpl, sleepImpl });
  const candidates = selectCandidates(all);
  summary.candidates = candidates.length;

  log(
    `Found ${all.length} owned repo(s); ${candidates.length} match the e2e throwaway prefix.`,
  );
  if (candidates.length === 0) {
    log("Nothing to do.");
    return summary;
  }

  log("");
  for (const [i, repo] of candidates.entries()) {
    log(`  [${i + 1}/${candidates.length}] ${describeCandidate(repo)}`);
  }
  log("");

  if (args.dryRun) {
    log("--dry-run: no prompts issued, nothing archived.");
    return summary;
  }

  for (const repo of candidates) {
    if (repo.archived) {
      // Already archived: listed above for visibility, but never prompted for — there is
      // nothing left to do to it, and a pointless prompt trains the user to type `y`.
      summary.alreadyArchived += 1;
      log(`  already archived, skipping: ${repo.full_name ?? repo.name}`);
      continue;
    }
    await confirmAndArchive({ repo, pat: pat.trim(), prompt, fetchImpl, sleepImpl, log, summary });
  }

  log("");
  log(
    `Summary — archived ${summary.archived}, skipped ${summary.skipped}, ` +
      `already archived ${summary.alreadyArchived}, refused by gate ${summary.refusedByGate}, ` +
      `failed ${summary.failed} (of ${summary.candidates} candidate(s)).`,
  );
  log(`Archived repos stay readable at ${GITHUB_API_BASE.replace("api.", "")}/<owner>/<name>; un-archive in Settings if you need one back.`);
  return summary;
}

export async function main() {
  try {
    await runCleanup();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}

// Run only when executed directly, so the exported functions stay unit-testable.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
