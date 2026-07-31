---
name: an-anti-vacuity-control-belongs-after-the-loop
description: "A type-shaped disjunction (`typeof v === 'string' || v === undefined`) is unfalsifiable; what saves a guarded assertion from vacuity is a live-arm control, and when the loop cannot tell which fixture it is on that control must come AFTER the loop"
metadata:
  type: convention
---

Two patterns, both measured in the dbos audio suite on 2026-07-30 (`fbede5b`).

**1. `expect(typeof v === "string" || v === undefined).toBe(true)` asserts the type, not the
behaviour.** `RequestSpeechArgs.voice` is declared `string | undefined`, so the disjunction
cannot fail for any value the type admits. Two copies existed (`render/audio.test.ts`,
`generate-audio/synthesize.test.ts`), each introduced to stop `undefined` from satisfying
the neighbouring `not.toContain`s for the wrong reason. That job was already being done by
the `if (typeof … === "string")` guard around them. Deleting both changed **no** result —
824/84 before and after — which is the proof they were dead.

**2. A guard converts a wrong-reason pass into a vacuous pass; only a live-arm control
closes it.** `U-S4c` had one (`expect(build(withVoice)[0].speech.voice).toBe("zac")`).
`U-RA8` did not, so a `narrationVoiceFor` that always returned `undefined` would make every
iteration skip the guard and the case pass having checked nothing.

**The control has to go AFTER the loop when the loop is fixture-blind.** `U-RA8` iterates
`[withChosenVoice("zac"), withChosenVoice()]` without knowing which manifest it is on, so
neither arm can assert a value locally. Collect into a `seen: (string | undefined)[]` and
`expect(seen).toContain("zac")` once the loop is done. `toContain` is safe here because
strings compare by value — see [[vitest-tocontain-object-identity]] for when it is not.

**Prove the control, not just the mutation.** Two runs, not one:
- mutation + new control ⇒ **red on the control's line**;
- mutation + control **removed** ⇒ **green**, which is what shows the control is doing the
  killing and that the vacuity it closes was real.
Run the mutation with `vitest -t "U-RA8"` **in isolation** — a sibling case (`U-RA6`) dies
first on the same mutation and masks the signal in a whole-file run. And `rm -rf
node_modules/.vite` between cycles ([[vite-cache-poisons-mutation-testing]]).

Related: [[a-test-that-claims-a-class-must-drive-the-class]],
[[a-guard-satisfied-by-its-own-residue]], [[tests-that-hold-invariants-vs-shapes]].
