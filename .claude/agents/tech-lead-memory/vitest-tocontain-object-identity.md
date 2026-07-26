---
name: vitest-tocontain-object-identity
description: Vitest's toContain compares array members by REFERENCE for objects, so `expect(values).toContain(someDate)` can be an unsatisfiable assertion — use expect.arrayContaining for deep membership.
metadata:
  type: reference
---

Hit 2026-07-26 in `src/gallery/gallery-query.test.ts` (task 39's red phase authored an assertion
no implementation could ever satisfy).

`expect(array).toContain(item)` uses `Array.prototype.includes` semantics — SameValueZero, i.e.
**reference identity for objects**. It is `toContainEqual` / `expect.arrayContaining([...])` that
compare deeply. The failure message is misleading, because Vitest pretty-prints both sides:

```
AssertionError: expected [ 2026-07-26T09:30:00.000Z, …(4) ] to include 2026-07-26T09:30:00.000Z
```

— which reads like a bug in the code under test, not a reference mismatch.

**The trap in TDD specifically:** a red test that asserts `toContain(aDateTheTestConstructed)`
against a value the implementation must *reconstruct* (here: a pagination epoch rebuilt from a
cursor's ISO string) is **unsatisfiable**, and there is no implementation that turns it green. That
is only discoverable once the module exists, so it survives a red-phase audit whose suite fails at
import.

**Rule:** for object membership use `expect(array).toEqual(expect.arrayContaining([x]))`.

**But keep the asymmetry when identity is the point.** In the same test, the NEGATIVE assertion
`expect(values).not.toContain(NOW)` is deliberately reference-based and is a *stronger* check than
a deep one: `NOW` is the very object handed to the builder as its clock, so its absence from the
bound values is exactly the proof that the clock was not bound. Deep-comparing there would have
weakened it. Positive → deep; negative-about-an-injected-object → identity.

See [[gallery-backend-built]].
