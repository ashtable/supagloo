/**
 * Type contract for `cleanup-e2e-repos.mjs` (design-delta §11 / D22, plan §5).
 *
 * The script is plain, zero-dependency, un-built ESM so `npm run cleanup:github-e2e`
 * keeps working with no compile step. Both the network call (`fetchImpl`) and the
 * interactive confirmation (`prompt`) are injectable, which is what lets
 * `tests/unit/cleanup-e2e-repos.test.ts` prove the safety properties with no network and
 * no TTY.
 */

import type { FetchLike, SleepLike } from "../tests/support/e2e-github-api.mjs";

export interface CleanupSummary {
  candidates: number;
  archived: number;
  skipped: number;
  alreadyArchived: number;
  refusedByGate: number;
  failed: number;
  dryRun: boolean;
}

export type PromptFn = (question: string) => Promise<string>;
export type LogFn = (...args: any[]) => void;

export function newSummary(): CleanupSummary;

/** Keep only repos whose name passes the hard gate. Real repos are never candidates. */
export function selectCandidates(repos: any[] | undefined): any[];

/** One human-readable block per candidate, so the confirmation is informed. */
export function describeCandidate(repo: any): string;

/**
 * Ask about ONE repo, then act — with `isE2eRepoName` re-checked HERE, at the mutation
 * site. A name that fails the gate is never actioned even if the user answered yes.
 * Mutates `summary`; never throws (one 403 must not abandon the run).
 */
export function confirmAndArchive(opts: {
  repo: any;
  pat: string;
  prompt?: PromptFn;
  fetchImpl?: FetchLike;
  sleepImpl?: SleepLike;
  log?: LogFn;
  summary: CleanupSummary;
}): Promise<void>;

/** List → filter → print → confirm-and-archive per repo → summarise. Never DELETEs. */
export function runCleanup(opts?: {
  env?: Record<string, string | undefined>;
  argv?: string[];
  fetchImpl?: FetchLike;
  sleepImpl?: SleepLike;
  prompt?: PromptFn;
  log?: LogFn;
}): Promise<CleanupSummary>;

export function main(): Promise<void>;
