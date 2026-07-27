import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `docs/render-sizing.md` IS ROW 45'S DELIVERABLE — its E2E column ends "findings recorded
 * in `docs/`" — and it is the artifact somebody would size a production container from.
 * Step 7 found **four separate false or overclaimed statements in it** (R45-3, R45-5,
 * R45-8, and RX-4's consequence), every one of them a sentence a reader would act on:
 *
 *   - R45-3: "overlap ratio 0.954 (<= 1.000 means no two renders overlapped)". The ratio is
 *     UTILIZATION; Step 8's M12 scored **0.0588** on a sample containing a COMPLETE overlap.
 *   - R45-3: "max simultaneous : 1 (PENDING render workflows, **ever**)". That figure comes
 *     from polled snapshots, so "ever" is an overclaim even where the number is right.
 *   - R45-5: "Remotion's concurrency defaults to half the machine's CPU threads" omits the
 *     **min-8 cap**, and "that default reads the host's thread count, not the container's
 *     cgroup quota" is wrong as stated — `os.availableParallelism()` and `nproc` both honour
 *     a **cpuset**; only a CFS **quota** escapes them. Also unmentioned: `resolveConcurrency`
 *     THROWS above the CPU count, at the render's last step, after the clone and the bundle.
 *   - RX-4 / item 15: every §3 number was measured with **no audio-synthesis stage**.
 *   - R45-8: "since nothing reclaims it" invites the reader to assume row 42's janitor will
 *     catch up. It structurally cannot — it selects failed/canceled jobs; these are
 *     completed.
 *
 * A prose correction with no fence is a comment, and this doc has now drifted from the code
 * twice. So the corrections are pinned here, by the words that were wrong.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DOC = readFileSync(resolve(ROOT, "docs/render-sizing.md"), "utf8");

describe("§2 — the serialization claim is not made from overlapRatio (R45-3)", () => {
  it("never ASSERTS that a ratio at or below 1 means no two renders overlapped", () => {
    // A proximity rule, not an absence rule: §2.1 has to be able to QUOTE the refuted
    // sentence in order to refute it. Every occurrence must sit within two lines of a
    // negation, so the claim can never be restated as fact. (Same self-defeating-guard
    // shape db-lib's U-CON-DOC hit in this run: an absence rule bans the correction too.)
    const lines = DOC.split("\n");
    const NEGATION = /\bfalse\b|\bnot\b|\bNOT\b|implies nothing|would have read/;
    const unrefuted: number[] = [];
    lines.forEach((line, i) => {
      if (!/means no two renders overlapped|1\.000 = strictly serial/.test(line)) return;
      const window = lines.slice(Math.max(0, i - 2), i + 3).join(" ");
      if (!NEGATION.test(window)) unrefuted.push(i + 1);
    });
    expect(unrefuted, `unrefuted at docs/render-sizing.md:${unrefuted.join(",")}`).toEqual(
      [],
    );
  });

  it("calls overlapRatio utilization and names the M12 counterexample", () => {
    expect(DOC).toMatch(/utilization/i);
    expect(DOC).toMatch(/0\.0588/);
  });

  it("reports the exact figure the claim now rests on", () => {
    expect(DOC).toMatch(/max concurrent/i);
    expect(DOC).toMatch(/maxIntervalOverlap/);
  });

  it("drops 'ever' from the max-simultaneous line — it sees polled snapshots only", () => {
    expect(DOC).not.toMatch(/PENDING render workflows, ever/);
    expect(DOC).not.toMatch(/\bever\)/);
  });
});

describe("§3.2 / §4 — Remotion's concurrency default (R45-5)", () => {
  it("states the real formula, cap included", () => {
    // `dist/get-concurrency.js`: Math.round(Math.min(8, Math.max(1, maxCpus / 2))).
    expect(DOC).toMatch(/min\(8,/);
    // Step 8's calibration: ":118 (defaults to half the machine's CPU threads) is NEARLY
    // right — it omits only the min-8 cap." So "half" must SURVIVE, with the cap added.
    expect(DOC).toMatch(/half the machine's CPU threads/);
  });

  it("no longer claims the default ignores the cgroup, which is wrong as stated", () => {
    expect(DOC).not.toMatch(/reads the host's thread count, not the container's cgroup quota/);
    expect(DOC).not.toMatch(/the default reads the host's thread count, not the cgroup quota/);
  });

  it("distinguishes a cpuset (honoured) from a CFS quota (not)", () => {
    expect(DOC).toMatch(/cpuset/i);
    expect(DOC).toMatch(/CFS/);
    expect(DOC).toMatch(/availableParallelism/);
  });

  it("states that too large a value THROWS, and where", () => {
    expect(DOC).toMatch(/Maximum for --concurrency is/);
    expect(DOC).toMatch(/boot/i);
  });
});

describe("§3 — the numbers were measured with NO audio synthesis (item 15 / RX-4)", () => {
  it("says so plainly, and says what a never-narrated subject would additionally cost", () => {
    expect(DOC).toMatch(/no audio[- ]synthesis stage/i);
    expect(DOC).toMatch(/canonicalizeManifest/);
    expect(DOC).toMatch(/live TTS/i);
  });

  it("no longer presents the dropped narration ref as a standing defect", () => {
    // It was fixed in the same run (dbos `src/remotion/manifest-json.ts`), so a doc that
    // still reads "it does not hold for narration" is the drift this file exists to stop.
    expect(DOC).not.toMatch(/and it does not hold for narration/);
  });
});

describe("§5 — the residue is permanent by default, and opt-in teardown exists (R45-8/D6)", () => {
  it("states that row 42's janitor will never reclaim these, and why", () => {
    expect(DOC).toMatch(/row 42/i);
    expect(DOC).toMatch(/completed/);
    expect(DOC).toMatch(/never reclaim/i);
  });

  it("documents --cleanup as OPT-IN and warns what it deletes", () => {
    expect(DOC).toMatch(/--cleanup/);
    expect(DOC).toMatch(/opt-in/i);
    expect(DOC).toMatch(/shared/i);
  });

  it("records what --cleanup does NOT reclaim", () => {
    expect(DOC).toMatch(/workflow_status/);
  });
});
