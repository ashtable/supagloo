---
name: owner-scoped-404-is-ambiguous
description: This codebase deliberately makes "not yours" and "not there" the same 404, so a cleanup loop that reads 404 as "deleted" silently leaks the row it was written to remove
metadata:
  type: constraint
---

Every owner-scoped mutation here answers **404 for both "no such row" and "not your row"**,
on purpose and by a single conditional write. `GalleryService.deleteItem` is the canonical
shape:

```ts
const { count } = await this.prisma.galleryItem.deleteMany({ where: { id, ownerId: userId } });
if (count === 0) throw new GalleryItemNotFoundError();
```

The docblock states the intent — *"a foreign item and a missing item are indistinguishable
(404) without a separate read"* — and the api pins it executably in `gallery.e2e.ts`
**`E-G15`: "DELETE by a non-owner 404s AND THE ITEM SURVIVES"**. The same 404-on-any-denial
rule governs the files presign service and the project routes.

**The trap.** Teardown code that does not know which of several fixture users owns a row
tends to loop over all of their tokens and stop on the first "success":

```ts
for (const token of owners.values()) {
  const status = await unpublishAsOwner(id, token);
  if (status === 200 || status === 404) { removed = true; break; }   // ← WRONG
}
```

A non-owner's 404 ends the search, and the row survives — while the code reports it
deleted. Found 2026-07-26 in `gallery-watch.e2e.ts`'s `afterAll`. It was latent only
because every publish in that spec happens as `fixtures.users[0]`, who is also first in the
Map; the moment anything publishes as a different owner it leaks a live PUBLIC gallery row,
which is the failure that once took down 21 UI tests
([[a-spec-that-writes-to-a-global-surface-owes-teardown]]) and which also rolls the entire
fixture teardown back on an FK violation
([[a-publishing-e2e-frees-its-own-render]]).

**The rule: only 200 means deleted.** Try every candidate owner, break on 200 only, and if
none answered 200 resolve the ambiguity with a *read* the caller is allowed to make — here
an anonymous `GET /api/gallery/:id`, where 404 genuinely does mean gone.

More generally: any code that infers state from this codebase's 404 is inferring from a
value that was designed to carry two meanings. Ask a second question instead of guessing.
