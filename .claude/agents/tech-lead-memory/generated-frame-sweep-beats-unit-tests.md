---
name: generated-frame-sweep-beats-unit-tests
description: for pure derivers with a huge input space, sweep the BUILT module over generated frames — it caught a mis-file that 147 unit tests and 8 killed mutations did not
metadata:
  type: convention
---

When a pure function maps a large, human-written input space onto a small closed output
set (the archetype here: `deriveScriptureBook` → 66 USFM codes), hand-written unit tests
and mutation testing are both **blind to interactions you did not think of**. Proven on
2026-07-26: a fix that made 147 targeted tests green and had 8/8 mutations killed still
introduced a cross-book mis-file (`"1 John and 1 John"` → JHN). What caught it, in under a
second, was a generated sweep.

The recipe, run against `dist/` (the artifact consumers get, not the TS source):
1. **Total coverage of the table** — every code, name and alias × a set of reference frames
   (`p`, `p 1`, `p 1:1`, `p.1.1`, `See p 1:1`, `p's 1:1`, …) must all return that code.
2. **Prose frames** — the same phrases × ordinary-English frames (`a p for you`,
   `the p of my life`, `p, p`, `p and p`, `read p today`, `p 23 KJV`, `top 10 ps`, …) must
   all return null. Print every non-null as a HIT and adjudicate each one by hand; the
   generator will produce accidental real references (`ho` + `s` → `hos 1:1`), so the
   signal is "HIT that names a DIFFERENT entity", not "HIT".
3. **Invariant over all ordered pairs** — 66×65 book pairs × multi-book frames must return
   the FIRST book. This is where wrong-facet bugs hide; 25,740 probes cost milliseconds.
4. **Hostile timing** — the same input at n=100/500/2000 segments, to prove a memo or guard
   really is linear rather than merely fast on the test's short strings.

Adjudicated HITs then become named unit tests, so the sweep is a **discovery** tool and the
suite stays the regression net. Keep the sweep script out of the repo (it is scaffolding);
what ships is the assertions it earned.

Related: [[scripture-book-reference-shape-rule]], [[vite-cache-poisons-mutation-testing]]
