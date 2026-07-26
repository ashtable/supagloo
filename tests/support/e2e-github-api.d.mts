/**
 * Type contract for `e2e-github-api.mjs` — the ONE real-GitHub e2e harness
 * (design-delta §11 / D3).
 *
 * The implementation is deliberately plain, zero-dependency, un-built ESM so that root,
 * api, dbos and nextjs can all dynamic-import the SAME file at runtime. This declaration
 * file exists so TypeScript consumers get real types without a build step — and it
 * doubles as the published contract for the three peer adapters.
 *
 * CREDENTIAL SPLIT (D6), restated here because it is the easiest thing to get wrong:
 * the App JWT is for discovery only; the PAT creates and archives repos (the installation
 * grants no `administration`); the INSTALLATION token does branch/file seeding AND every
 * assertion read — never the PAT, because a PAT is a stronger credential than production
 * ever holds, so reading with it could green-light a permission the product lacks.
 */

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
export type SleepLike = (ms: number) => Promise<unknown>;

/** api and dbos pass db-lib's own `signAppJwt` here so the harness exercises the PRODUCT signer. */
export type SignJwt = (args: {
  appId: string;
  privateKey: string;
}) => string | Promise<string>;

export interface TransportOptions {
  fetchImpl?: FetchLike;
  sleepImpl?: SleepLike;
}

export interface GithubResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  // Parsed JSON when the body is JSON, the raw text otherwise, undefined when empty.
  body: any;
  /** The `Link: rel="next"` URL, when the response carried one. */
  next?: string;
}

export interface GithubE2eSecrets {
  appId: string;
  appSlug: string;
  /** PEM with real newlines, normalised from whatever form `.env` mangled it into. */
  privateKey: string;
  pat: string;
}

export interface DiscoveredInstallation {
  installationId: string;
  ownerLogin: string;
  accountType: string;
  repositorySelection?: string;
}

export const GITHUB_API_BASE: string;
export const GITHUB_WEB_BASE: string;

export function rootDirPath(): string;
export function rootEnvPath(rootDir?: string): string;

/** `process.loadEnvFile(<root>/.env)`. Never overrides an already-set variable. */
export function loadRootEnv(opts?: {
  envFile?: string;
  rootDir?: string;
}): string | undefined;

/** `{appId, appSlug, privateKey, pat}` or a throw naming the variable + `.env` + `.env.example`. */
export function resolveGithubE2eSecrets(opts?: {
  env?: Record<string, string | undefined>;
  rootDir?: string;
}): GithubE2eSecrets;

/** Idempotent normalisation of escaped-\n / quoted / CRLF PEM forms (row 62 item (c)). */
export function normalizePemNewlines(raw: unknown): string;

/** RS256 App JWT. root/nextjs use this; api/dbos pass db-lib's signer via `signJwt`. */
export function signAppJwtLocal(args: {
  appId: string;
  privateKey: string;
  now?: number;
}): string;

export function parseNextLink(linkHeader: string | null | undefined): string | undefined;

/**
 * The one HTTP door to GitHub: bounded retries honouring `Retry-After` /
 * `x-ratelimit-reset`, throwing on any status outside 2xx unless listed in
 * `allowStatuses`. The token never appears in an error message.
 */
export function githubFetch(
  url: string,
  opts?: TransportOptions & {
    method?: string;
    token?: string;
    body?: unknown;
    headers?: Record<string, string>;
    maxAttempts?: number;
    allowStatuses?: number[];
    label?: string;
  },
): Promise<GithubResponse>;

/** Bounded retry for a real-host read — GitHub's pulls/refs indexes are not transactional. */
export function retryRead<T>(
  read: () => T | Promise<T>,
  opts?: { attempts?: number; delayMs?: number; sleepImpl?: SleepLike },
): Promise<T>;

/** Test-only: drop the per-process installation memo. */
export function resetInstallationCache(): void;

/** Runtime installation discovery with five distinct fail-fast throws (D5). */
export function discoverInstallation(opts: TransportOptions & {
  appId: string;
  appSlug?: string;
  privateKey: string;
  ownerLogin?: string;
  signJwt?: SignJwt;
  env?: Record<string, string | undefined>;
}): Promise<DiscoveredInstallation>;

export function mintInstallationTokenLocal(
  opts: TransportOptions & {
    appId: string;
    privateKey: string;
    installationId: string;
    signJwt?: SignJwt;
  },
): Promise<string>;

/** `POST /user/repos` with the PAT. `auto_init: true` is load-bearing — see D6. */
export function createFixtureRepo(
  opts: TransportOptions & {
    pat: string;
    slug: string;
    runId?: string;
    spec?: string;
  },
): Promise<any>;

/** Gate #1 before any enqueue: the repo AND its default branch answer. */
export function waitForRepoReady(
  opts: TransportOptions & {
    pat: string;
    owner: string;
    repo: string;
    branch?: string;
    timeoutMs?: number;
    nowImpl?: () => number;
  },
): Promise<any>;

/** Gate #2 before any enqueue: the installation lists the repo. */
export function waitForInstallationVisibility(
  opts: TransportOptions & {
    token: string;
    fullName: string;
    timeoutMs?: number;
    nowImpl?: () => number;
  },
): Promise<boolean>;

/** PAT-only. ARCHIVES. There is no delete helper here, deliberately. */
export function archiveRepo(
  opts: TransportOptions & { pat: string; owner: string; repo: string },
): Promise<any>;

export function listOwnerRepos(
  opts: TransportOptions & { pat: string },
): Promise<any[]>;

export function createRef(
  opts: TransportOptions & {
    token: string;
    owner: string;
    repo: string;
    branch: string;
    fromBranch?: string;
  },
): Promise<any>;

export function putContents(
  opts: TransportOptions & {
    token: string;
    owner: string;
    repo: string;
    branch: string;
    path: string;
    content: string;
    message?: string;
  },
): Promise<any>;

/** `state` defaults to "all" ON PURPOSE — a merged PR is closed (D9 / D18-1). */
export function listPulls(
  opts: TransportOptions & {
    token: string;
    owner: string;
    repo: string;
    state?: string;
    head?: string;
  },
): Promise<any[]>;

export function listTagRefs(
  opts: TransportOptions & { token: string; owner: string; repo: string },
): Promise<any[]>;

export function listBranches(
  opts: TransportOptions & { token: string; owner: string; repo: string },
): Promise<any[]>;

/** Commit count on a branch; a 409 ("Git Repository is empty") counts as 0. */
export function countCommitsOnBranch(
  opts: TransportOptions & {
    token: string;
    owner: string;
    repo: string;
    branch?: string;
  },
): Promise<number>;

export { E2E_RUN_ID, buildE2eRepoName, buildE2eRepoDescription } from "./e2e-github-naming.mjs";
