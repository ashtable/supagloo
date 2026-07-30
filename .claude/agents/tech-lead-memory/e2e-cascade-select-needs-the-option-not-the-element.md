---
name: e2e-cascade-select-needs-the-option-not-the-element
description: Driving a live-loaded cascade <select> in an e2e must wait for the OPTION and read the value back — waiting for the element is a silent no-op that fails one level downstream; plus the two other races that cost four real-lane runs on the wizard's scripture step
metadata:
  type: convention
---

Learned **2026-07-30** getting `supagloo-nextjs`
`tests/e2e/studio-wizard-scripture-carry.e2e.ts` green. Four failed real-lane runs, three
distinct harness races. All three rules now live in `tests/e2e/github-e2e.ts`.

## 1. Wait for the OPTION, then read the value back

`selectTestIdOption` originally did `page.evaluate` → native value setter → `dispatchEvent`.
The caller waited for `waitForTestId("wizard-picker-book")` (the ELEMENT) but
`waitForTestIdOption` (the OPTION) only for the level *below* it. `GET /api/bible/books` took
358 ms, so at assignment time the select held nothing but its `"select book"` placeholder.

**Assigning a `<select>` a value it does not offer is a silent no-op**: the DOM sets
`selectedIndex = -1` and `value` becomes `""`, so React's `onChange` fired with `""`,
`selection.book` stayed null, `GET /api/bible/chapters` was never issued at all, and the
failure surfaced 74 s later as *"wizard-picker-chapter never offered the option 23"* — one
cascade level below its cause. (React does NOT suppress `onChange` on a disabled control; only
mouse events are gated by `disabled`. The missing option is the whole mechanism.)

The wait belongs **inside** the select helper, not in the caller — leaving it to the caller is
exactly how it goes missing. And read the value back afterwards, so a no-op assignment fails
where it happened instead of being inferred from a timeout somewhere below.

Because these selects are `disabled={!items || items.length === 0}`, the option existing is
also the moment the control is enabled: **one wait covers both gates**.

Levels the helper does not drive need no wait of their own, and that is a property rather than
luck — books only fetch once `bibleId` is set, which only happens once translations resolved a
default, which needs a language. Waiting for the BOOK option transitively proves everything
above it landed.

## 2. Do not assert a cascade select's DOM value as a proxy for its React state

Asserting LANGUAGE non-empty cost a whole run (`LANGUAGE="" / TRANSLATION="12"`).
`selection.languageTag` is seeded at mount, so the translation chain never waits for the
language LIST — but the select's DOM value is that state matched against options rendered from
the list, and until the list lands (8583 records, ~780 KB, the slowest read in the cascade) the
browser reports `""` for a select whose React value is `"en"`. Books routinely beat it. The
manifest carries `"language": "en"` either way.

## 3. A preview that confirms one granularity is not a signal that the DEFAULT settled

Selecting a chapter dispatches **two** reads at once — `GET /api/bible/verses` (which produces
the default `min(5, n)` verse range) and `GET /api/bible/passage` for the chapter's own id
(because no range exists yet). They race: 102 ms vs 336 ms measured. Clicking the CTA as soon
as ANY preview rendered scaffolded `{passageId: "PSA.23", reference: "Psalms 23"}` — the whole
chapter — so the range assertion had nothing to find. Not a product bug: the wizard persisted
what the provider had confirmed at the moment of the click, and nothing was fabricated. But a
helper that quietly persists a different granularity than its docblock promises is worse than
one that fails.

The settled state is three DOM facts at once (tray present + ≥1 `data-selected="true"` chip +
preview present), observed twice.

Related: [[dbos-worker-had-no-youversion-key]], [[studio-inspector-requires-scenes]],
[[real-github-e2e-harness]], [[next-dev-compiles-routes-on-first-request]],
[[wizard-ready-card-redirect-needs-a-confirmed-slug]].
