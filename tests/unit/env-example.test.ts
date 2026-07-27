import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ROOT `.env.example` IS THE OPERATOR CONTRACT — plan row 43.
 *
 * Root's untracked `.env` is the ONE file a developer edits, and Compose's `${VAR}`
 * substitution is the ONLY way a credential reaches a container (memory
 * `never-inline-secrets-in-tracked-config`). `.env.example` is therefore not documentation
 * in the decorative sense: it is the list of names that file must contain, and a name that
 * is substituted by a Compose file but absent from `.env.example` is a variable nobody
 * knows to set. Compose substitutes an unset variable with the EMPTY STRING and warns on
 * stderr; the container then boots with a blank credential and fails much later, somewhere
 * else. That is precisely how row 43's own D43.3 finding happened — the `nextjs` service
 * had no `environment:` block at all, so `YOUVERSION_APP_KEY` reached neither the build nor
 * the container and nothing anywhere said so.
 *
 * Four checkouts each keep their own `.env.example` (they are separately runnable), so the
 * names drift. This file pins the two directions that actually matter and deliberately not
 * more:
 *
 *   1. Compose `${VAR}` ⊆ root `.env.example`  — the mechanical reconciliation.
 *   2. dbos's operator KNOBS (RENDER_* / CLEANUP_*) ⊆ root `.env.example` — these are set
 *      in root's `.env` and passed through by `docker-compose.yml`, so a knob documented
 *      only in the dbos checkout is undiscoverable from where it is actually configured.
 *
 * It deliberately does NOT demand set-equality in any direction: root legitimately carries
 * host-side-only harness vars (`GITHUB_E2E_PAT_TOKEN`, `SUPAGLOO_E2E_GITHUB_OWNER`) that no
 * container ever sees, and each service legitimately documents its own internal defaults
 * (`PORT`, `HOST`, `GITHUB_API_BASE_URL`) that root never sets.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SIBLINGS = resolve(ROOT, "..");

const ROOT_ENV_EXAMPLE = readFileSync(resolve(ROOT, ".env.example"), "utf8");

const COMPOSE_FILES = [
  "docker-compose.yml",
  "docker-compose.test.yml",
] as const;

/**
 * Every `${VAR}` / `${VAR:-default}` name a tracked compose file actually substitutes.
 *
 * COMMENT LINES ARE NOT SUBSTITUTIONS. Both compose files explain the mechanism in prose
 * ("via Compose's built-in ${VAR} substitution"), and counting that as a variable named
 * `VAR` would make this guard permanently and meaninglessly red. Same classification rule
 * as `e2e-prefix-single-source.test.ts`.
 */
function substitutedNames(source: string): string[] {
  const names = new Set<string>();
  for (const line of source.split("\n")) {
    if (/^\s*#/.test(line)) continue;
    for (const m of line.matchAll(/\$\{([A-Z][A-Z0-9_]*)(?::?-[^}]*)?\}/g)) {
      names.add(m[1]);
    }
  }
  return [...names].sort();
}

/** Names `.env.example` DOCUMENTS: an assignment line, or a bare mention in prose. A
 *  variable that is only described (not assigned) still tells the operator it exists. */
function documentedNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const m of source.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)) names.add(m[1]);
  return names;
}

/** Assignment lines only, with their raw values. */
function assignments(source: string): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  for (const m of source.matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm)) {
    out.push({ key: m[1], value: m[2] });
  }
  return out;
}

const rootDocumented = documentedNames(ROOT_ENV_EXAMPLE);

describe("root .env.example documents every variable Compose substitutes", () => {
  it.each(COMPOSE_FILES)("%s", (file) => {
    const source = readFileSync(resolve(ROOT, file), "utf8");
    const missing = substitutedNames(source).filter(
      (name) => !rootDocumented.has(name) && !ROOT_ENV_EXAMPLE.includes(name),
    );
    expect(
      missing,
      `${file} substitutes ${missing.join(", ")}, which root/.env.example never names`,
    ).toEqual([]);
  });
});

describe("root .env.example documents the dbos worker's operator knobs", () => {
  // The `dbos` service's RENDER_* and CLEANUP_* keys are all OPTIONAL with real defaults,
  // so a missing one never breaks a boot — which is exactly why they go undiscovered. They
  // are set in ROOT's `.env`, so root is where they have to be listed.
  const DBOS_ENV_EXAMPLE = resolve(SIBLINGS, "supagloo-nodejs-dbos", ".env.example");

  it("finds the dbos checkout (absent is reported DISTINCTLY from drift)", () => {
    expect(existsSync(DBOS_ENV_EXAMPLE) ? "" : DBOS_ENV_EXAMPLE).toBe("");
  });

  it("names every RENDER_* / CLEANUP_* knob dbos documents", () => {
    const dbosKeys = [...documentedNames(readFileSync(DBOS_ENV_EXAMPLE, "utf8"))].filter(
      (k) => k.startsWith("RENDER_") || k.startsWith("CLEANUP_"),
    );
    expect(dbosKeys.length).toBeGreaterThan(0);
    const missing = dbosKeys.filter((k) => !rootDocumented.has(k)).sort();
    expect(
      missing,
      `dbos documents ${missing.join(", ")} but root/.env.example does not`,
    ).toEqual([]);
  });
});

describe("root .env.example records the nextjs credential rules (D43.3 / §9 S4)", () => {
  it("documents the YOUVERSION_APP_KEY -> YV_APP_KEY rename at the Compose boundary", () => {
    // The backends spell the credential YOUVERSION_APP_KEY; supagloo-nextjs spells it
    // YV_APP_KEY. That divergence is pre-existing and is bridged by a `${}` substitution in
    // the nextjs service, which is invisible unless it is written down where the operator
    // sets the value.
    expect(ROOT_ENV_EXAMPLE).toContain("YV_APP_KEY");
  });

  it("says the secrets key must NEVER be given to nextjs", () => {
    const idx = ROOT_ENV_EXAMPLE.indexOf("YV_APP_KEY");
    expect(idx).toBeGreaterThan(-1);
    const section = ROOT_ENV_EXAMPLE.slice(Math.max(0, idx - 1500), idx + 1500);
    expect(section).toMatch(/SECRETS_ENCRYPTION_KEY/);
    expect(section).toMatch(/never/i);
  });
});

describe("no .env.example in any checkout carries a live credential", () => {
  // memory `never-inline-secrets-in-tracked-config`: keys live in the untracked `.env` and
  // reach containers via ${VAR}. A tracked example file must ship the NAME and an empty
  // value — never the value. Enforced across all four checkouts because a leak in any one
  // of them is a leak in this project.
  const CHECKOUTS = [
    { label: "root", dir: ROOT },
    { label: "api", dir: resolve(SIBLINGS, "supagloo-nodejs-api") },
    { label: "dbos", dir: resolve(SIBLINGS, "supagloo-nodejs-dbos") },
    { label: "nextjs", dir: resolve(SIBLINGS, "supagloo-nextjs") },
  ] as const;

  /** Key-name fragments that mark a value as credential material. */
  const CREDENTIAL_RE = /(SECRET|TOKEN|_KEY|PASSWORD|PAT)\b|_KEY$/;

  /**
   * The ONE deliberate exception, allow-listed BY NAME with its reason rather than by a
   * loose pattern: the well-known dev-only AES key. It is identical in
   * docker-compose.yml, is asserted byte-identical across api + dbos by
   * compose-config.test.ts's PART V invariant 5, and its whole purpose is that
   * `docker compose up` works with no `.env` at all. Every occurrence is labelled
   * dev-only (invariant 7).
   */
  const DEV_KEY = "0123456789abcdef".repeat(4);

  it.each(CHECKOUTS)("$label", ({ dir }) => {
    const path = resolve(dir, ".env.example");
    if (!existsSync(path)) return;
    const leaked = assignments(readFileSync(path, "utf8"))
      .filter(({ key, value }) => {
        if (!CREDENTIAL_RE.test(key)) return false;
        const v = value.trim();
        if (v === "") return false;
        if (v === DEV_KEY) return false;
        // Compose-style passthrough and the obviously-fake local dev values.
        return !/^\$\{/.test(v) && !/^supagloo(-dev)?$/.test(v);
      })
      .map(({ key }) => key);
    expect(leaked, `${path} assigns a non-empty value to ${leaked.join(", ")}`).toEqual(
      [],
    );
  });
});
