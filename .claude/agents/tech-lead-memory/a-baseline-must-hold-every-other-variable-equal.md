---
name: a-baseline-must-hold-every-other-variable-equal
description: A live e2e "the paginated walk returns more than one page" survived replacing the loop with `while (false)` — because the baseline probe omitted the page_size the client sends, so the test was measuring page_size while claiming to measure the walk
metadata:
  type: convention
---

Found and fixed 2026-07-30 while adding
`dbos/tests/e2e/youversion-passage-live.e2e.ts` E-YVL1.

## The test

dbos's `getBibleCollection` had no pagination: no `page_size`, no `next_page_token`. The new
version walks the tokens. The live assertion was written to be **self-calibrating** — the
provider's page size is not documented and the catalogue size changes, so neither may be
written down:

```ts
const first = await rawFirstPage("*");        // one raw request, NO page_size
const all   = await getBibleCollection({ language: "*" });
expect(all.length).toBeGreaterThan(first.count);
```

Green. Then the mutation: `} while (pageToken);` → `} while (false);`.

**Still green.** `do…while(false)` runs the body once, and the body now sends
`page_size=50` — so the client's single page (50) still beat the provider's *default* page
(25). The assertion was measuring **that `page_size` is sent**, not that the token is
followed. A whole category of pagination bug — the token silently ignored — would have
shipped under a green live test.

## The rule

A self-calibrating baseline is only self-calibrating for the variable it isolates. If the
change under test alters **two** things (here: the page size AND the number of requests), the
baseline must hold the other one **equal**, or the assertion measures whichever one happens
to differ. The fix was to export `COLLECTION_PAGE_SIZE` from the client and have the baseline
request one page **at the client's own page size** — after which only following the token can
produce a difference, and the mutation dies with `expected 50 to be greater than 50`.

The `page_size` half is then pinned separately, where it belongs: a unit test with an
injected fetch asserting the URL contains `page_size=` (verified to go red on its own
mutation). One property per assertion; two properties in one comparison means neither is
held.

## The generalisation

"More than a baseline" is a **difference** assertion, and a difference is only attributable if
exactly one thing differs. Before trusting one, ask what else the diff changed — and then
mutate. This is the same failure family as [[an-isolation-seam-can-hide-the-property]] (the
seam narrowed the population the property was about) and
[[nextjs-unit-lane-component-rendering]]'s trap 3 (a remount re-runs every effect, so the
setup was larger than the property). In all three the test passed for a reason adjacent to
the one claimed.

Related: [[a-test-that-claims-a-class-must-drive-the-class]],
[[tests-that-hold-invariants-vs-shapes]], [[youversion-verse-range-is-echoable]].
