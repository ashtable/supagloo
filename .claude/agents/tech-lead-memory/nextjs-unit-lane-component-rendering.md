---
name: nextjs-unit-lane-component-rendering
description: supagloo-nextjs CAN now render React components in the unit lane (jsdom opt-in, hand-rolled ~60-line renderer) — plus the two traps that cost time the first time
metadata:
  type: convention
---

`supagloo-nextjs`'s unit lane could not render components until 2026-07-26 (row 41's
Step-11 revisions). It can now, and the capability is deliberately opt-in.

**The setup.** `vitest.config.ts` keeps `environment: "node"` as the default — the lane is
overwhelmingly pure-logic tests over `lib/**` and a DOM would only slow them down. A
`.test.tsx` under `tests/unit/` opts in with a `// @vitest-environment jsdom` docblock.
Two things had to be added: the `jsdom` devDependency, and a `resolve.alias` for `@` →
repo root (Vite does not read tsconfig `paths`, and every component imports `@/lib/…`).
`tests/unit/**/*.test.tsx` joined the `include` list.

**No testing-library.** `tests/unit/support/render.tsx` is ~60 hand-rolled lines over
`react-dom/client` + `act`: `mount`, `byTestId`/`queryTestId`, `click`, `type`, `flush`,
`deferred`. Every component in this app already carries `data-testid` for the Stagehand
specs, so RTL would have been a dependency for sugar — same call as
`e2e-lane-coverage.test.ts`'s hand-rolled glob matcher. `globalThis.IS_REACT_ACT_ENVIRONMENT
= true` is required; Vitest does not set it. `type()` must go through the native value
setter (React overrides `value` on the DOM node).

**Why it was worth adding.** `mounted-guard-strictmode.test.ts` settled for a SOURCE guard
and says in its header that component rendering "is not available in this repo's unit
lane" — that sentence is now out of date. Two of row 41's four review findings were async
control-flow defects *inside* a client component (a stale-run early return that skipped an
in-flight flag reset; a dialog whose `useState` initializers only ran once per page load).
Neither is reachable from a pure-logic test, and both e2e specs that touch the same code
paths are structurally unable to see them — they never interact *underneath* an open
request. Holding a request open with `deferred()` and clicking underneath it is the whole
technique.

**Two traps, both of which cost real time:**

1. **`vi.clearAllMocks()` does NOT drain the `mockReturnValueOnce` queue.** It clears the
   call log only. One unconsumed `…Once` silently answers the NEXT test's first request,
   so a single honest failure cascades into unrelated ones ("no element with
   data-testid=…" three tests later). Use `vi.resetAllMocks()`. This is what made a wrong
   hypothesis look like three bugs.
2. **Unmount in `afterEach`, never at the end of the test body.** A failing test never
   reaches a trailing `unmount()`, so its component stays mounted with live effects.

**Mocking:** `vi.mock("@/app/_components/session-provider", …)` — the real provider drags
in `@youversion/platform-react-ui`, which throws outside a `<YouVersionAuthProvider>`.
Mock `@youversion/platform-react-ui` itself when `sign-in-button` is anywhere in the tree
(it is, via `signin-prompt`). `<Modal>` portals to `document.body`, so dialog queries root
there, not at the container.

## Trap 3 — a REMOUNT proves nothing about a dependency array

Added 2026-07-29. `workspace-grid-gating.test.tsx` U-A8 claimed "the grid fetches once the
server session arrives, with no reload" and drove it as
`mount → unmount → change the mock → mount again`. A fresh mount runs every effect
unconditionally, so that sequence passes **identically with the broken deps** it exists to
catch. Measured: reverting `[mounted, isMock, serverUserId]` to `[mounted, isMock]` left
the whole 1253-test lane green.

Whenever the claim is *an effect fires because a VALUE changed*, drive **one mounted tree**:
`support/render.tsx` now returns a `rerender(element)` that renders into the same root, so
the fiber survives and only changed deps re-run. Two assertions make it airtight —
`expect(byTestId(container, id)).toBe(theNodeCapturedBefore)` (no unmount happened) and a
same-value re-render that must NOT refetch (the array is doing work, not the render).

Same shape as [[a-test-that-claims-a-class-must-drive-the-class]]: the setup was quietly
larger than the property, so the property was never under test.

Related: [[gallery-ui-built]], [[vite-cache-poisons-mutation-testing]],
[[a-test-that-claims-a-class-must-drive-the-class]].
