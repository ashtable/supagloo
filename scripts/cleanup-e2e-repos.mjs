#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import { isE2eRepoName } from "../tests/support/e2e-github-naming.mjs";
import {
  GITHUB_API_BASE,
  archiveRepo,
  deleteRepo,
  listOwnerRepos,
  loadRootEnv,
} from "../tests/support/e2e-github-api.mjs";

/**
 * INTERACTIVE CLEANUP OF E2E GITHUB ARTIFACT REPOS.  Deletes in reviewed batches.
 * ==============================================================================
 *
 *   npm run cleanup:github-e2e             # from the root repo — DELETES
 *   node scripts/cleanup-e2e-repos.mjs --dry-run
 *   node scripts/cleanup-e2e-repos.mjs --archive        # reversible: archive instead
 *   node scripts/cleanup-e2e-repos.mjs --batch 25
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
 * DELETION, AND WHY THE DEFAULT CHANGED (2026-07-29)
 * -------------------------------------------------
 * This script archived and never deleted, on the argument that archiving is reversible.
 * That argument did not survive contact with the volume: a measurement on 2026-07-29
 * found **507 throwaway repos against 385 real ones** in the account. Archived repos are
 * still listed, still counted, and still paged through — and `awaitInstallationVisibility`
 * pages the installation's repo list inside a 60s budget, so the pile had begun making
 * the create-new-repo e2e fail with a secondary-rate-limit 403. Archiving had stopped
 * being reclamation and become a rename.
 *
 * `--archive` keeps the old, reversible behaviour for when that is what you want. What
 * did NOT change is the thing that makes either action safe:
 *
 *  1. THE PREFIX IS A HARD GATE, RE-CHECKED AT THE MUTATION SITE. `isE2eRepoName` is
 *     imported from `tests/support/e2e-github-naming.mjs` — the ONE authored home of the
 *     prefix (D1) — and it is evaluated again inside `actOnRepo`, immediately before the
 *     request. A name that fails it is NEVER actioned even if the user confirmed the
 *     batch it appeared in. That makes the prefix a code invariant rather than a
 *     filtering side effect, so a mis-listed row plus a reflexive Enter is structurally
 *     incapable of touching a real repo. This matters MORE now than it did when the
 *     action was reversible.
 *
 *  2. REVIEW BEFORE MUTATION, in batches. One screen of at most `--batch` repos (default
 *     10) is printed in full — owner/name, visibility, state, dates, stamped description
 *     — and confirmed as a unit. Enter accepts, because a 500-repo backlog answered one
 *     prompt at a time is what trained the reflex this gate has to survive; `n` skips the
 *     whole batch, `q` stops the run. There is still NO `--yes-to-all`: every repo that
 *     dies was on a screen a human saw and accepted, which is the property worth keeping.
 *
 *  3. ARCHIVED REPOS ARE CANDIDATES TOO. They used to be listed and then skipped, since
 *     archiving one twice is a no-op. Under deletion they are exactly the backlog you are
 *     here to clear, so they are offered like anything else — and skipped only when the
 *     action itself would be a no-op (`--archive` over an already-archived repo).
 *
 * A token value is never printed, in whole or in part.
 */

const AFFIRMATIVE = new Set(["y", "yes"]);

export function newSummary() {
  return {
    candidates: 0,
    deleted: 0,
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
 * Act on ONE repo, with the prefix gate re-checked here, at the mutation site.
 *
 * Called only for repos in a batch the user already accepted, so it does not prompt.
 * Mutates `summary` and never throws: one 403 must not abandon the rest of the run.
 */
export async function actOnRepo({
  repo,
  pat,
  mode = "delete",
  fetchImpl,
  sleepImpl,
  log = console.log,
  summary,
}) {
  const owner = repo.owner?.login ?? repo.full_name?.split("/")[0];
  const name = repo.name;

  // THE HARD GATE, at the mutation site. Not redundant with selectCandidates: this is
  // what makes "never touch a real repo" a property of the mutating code itself, and it
  // is the last thing standing between a mis-listed row and an irreversible DELETE.
  if (!isE2eRepoName(name)) {
    summary.refusedByGate += 1;
    log(
      `  REFUSED ${owner}/${name} — the name does not match the e2e throwaway prefix, ` +
        "so this script will not touch it (even though its batch was accepted).",
    );
    return;
  }

  if (mode === "archive" && repo.archived) {
    summary.alreadyArchived += 1;
    log(`  already archived, nothing to do: ${owner}/${name}`);
    return;
  }

  try {
    if (mode === "archive") {
      await archiveRepo({ pat, owner, repo: name, fetchImpl, sleepImpl });
      summary.archived += 1;
      log(`  archived ${owner}/${name}`);
    } else {
      await deleteRepo({ pat, owner, repo: name, fetchImpl, sleepImpl });
      summary.deleted += 1;
      log(`  deleted  ${owner}/${name}`);
    }
  } catch (err) {
    summary.failed += 1;
    const verb = mode === "archive" ? "archive" : "delete";
    log(`  FAILED to ${verb} ${owner}/${name}: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Show one batch in full and ask once. Enter (empty) means YES — that is the requested
 * default and the reason the per-repo gate above is not negotiable.
 *
 * Returns "yes" | "skip" | "quit".
 */
export async function confirmBatch({
  batch,
  index,
  total,
  mode = "delete",
  prompt = defaultPrompt,
  log = console.log,
}) {
  const verb = mode === "archive" ? "ARCHIVE" : "DELETE";
  log("");
  log(`── batch ${index} of ${total} — ${batch.length} repo(s) ──`);
  for (const [i, repo] of batch.entries()) {
    log(`  [${i + 1}] ${describeCandidate(repo)}`);
  }
  log("");
  const answer = String(
    await prompt(`${verb} these ${batch.length}? [Y/n/q] `),
  )
    .trim()
    .toLowerCase();

  if (answer === "" || AFFIRMATIVE.has(answer)) return "yes";
  if (answer === "q" || answer === "quit") return "quit";
  return "skip";
}

/** Split into fixed-size batches, preserving order. */
export function chunk(items, size) {
  const n = Number.isFinite(size) && size > 0 ? Math.floor(size) : 10;
  const out = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

export function parseArgs(argv) {
  const out = { dryRun: false, envFile: undefined, mode: "delete", batch: 10 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--archive") out.mode = "archive";
    else if (arg === "--batch") out.batch = Number(argv[++i]);
    else if (arg.startsWith("--batch=")) out.batch = Number(arg.slice("--batch=".length));
    else if (arg === "--env-file") out.envFile = argv[++i];
    else if (arg.startsWith("--env-file=")) out.envFile = arg.slice("--env-file=".length);
    else if (arg === "--help" || arg === "-h") out.help = true;
    else
      throw new Error(
        `Unknown argument ${arg}. Supported: --dry-run, --archive, --batch <n>, --env-file <path>.`,
      );
  }
  if (!Number.isFinite(out.batch) || out.batch < 1) {
    throw new Error("--batch must be a positive integer (default 10).");
  }
  return out;
}

const HELP = `cleanup-e2e-repos — interactively DELETE Supagloo e2e throwaway repos.

  --dry-run           list candidates and exit (no prompts, no mutation)
  --archive           archive instead of deleting (reversible)
  --batch <n>         repos per confirmation screen (default 10)
  --env-file <path>   read credentials from this .env instead of <root>/.env

Reviews in batches: one screen of repos is printed in full, then confirmed as a unit.
Enter accepts the batch (Y is the default), \`n\` skips it, \`q\` stops the run.

Only names matching the e2e throwaway prefix are ever candidates, and the prefix is
re-checked immediately before each request — an accepted batch still cannot touch a repo
whose name does not match.

DELETION IS PERMANENT. Requires GITHUB_E2E_PAT_TOKEN with the classic \`delete_repo\`
scope; with only \`repo\` each delete fails 403 and is reported per repo. Use --archive
if you want the reversible action. There is intentionally no --yes-to-all.`;

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

  if (args.dryRun) {
    for (const [i, repo] of candidates.entries()) {
      log(`  [${i + 1}/${candidates.length}] ${describeCandidate(repo)}`);
    }
    log("");
    log("--dry-run: no prompts issued, nothing changed.");
    return summary;
  }

  const batches = chunk(candidates, args.batch);
  log(
    `Reviewing in ${batches.length} batch(es) of up to ${args.batch}. ` +
      `Enter accepts a batch, \`n\` skips it, \`q\` stops.`,
  );
  if (args.mode !== "archive") {
    log("DELETION IS PERMANENT — there is no undo and no grace period.");
  }

  for (const [bi, batch] of batches.entries()) {
    const answer = await confirmBatch({
      batch,
      index: bi + 1,
      total: batches.length,
      mode: args.mode,
      prompt,
      log,
    });

    if (answer === "quit") {
      // Everything not yet reviewed is untouched, and says so — a run that stops halfway
      // must not read as a run that finished.
      const remaining = batches.slice(bi).reduce((n, b) => n + b.length, 0);
      summary.skipped += remaining;
      log(`  stopping at your request — ${remaining} repo(s) left untouched.`);
      break;
    }
    if (answer === "skip") {
      summary.skipped += batch.length;
      log(`  skipped this batch (${batch.length} repo(s)).`);
      continue;
    }

    for (const repo of batch) {
      await actOnRepo({
        repo,
        pat: pat.trim(),
        mode: args.mode,
        fetchImpl,
        sleepImpl,
        log,
        summary,
      });
    }
  }

  log("");
  log(
    `Summary — deleted ${summary.deleted}, archived ${summary.archived}, ` +
      `skipped ${summary.skipped}, already archived ${summary.alreadyArchived}, ` +
      `refused by gate ${summary.refusedByGate}, failed ${summary.failed} ` +
      `(of ${summary.candidates} candidate(s)).`,
  );
  if (summary.archived > 0) {
    log(
      `Archived repos stay readable at ${GITHUB_API_BASE.replace("api.", "")}/<owner>/<name>; ` +
        "un-archive in Settings if you need one back.",
    );
  }
  if (summary.failed > 0 && args.mode !== "archive") {
    log(
      "A 403 on every delete means the PAT lacks the classic `delete_repo` scope — " +
        "grant it, or re-run with --archive.",
    );
  }
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
