---
name: youversion-bible-read-surface-lives-in-nextjs
description: The studio scripture picker's Bible read surface is six nextjs BFF routes calling api.youversion.com directly — NOT the api, NOT @youversion/platform-core — plus the live route facts that make the picker cheap (page_size=* one-shot, the 1.59 MB /books trap, the 204)
metadata:
  type: decision
---

Task item 1 of the genesis-1 render-bug run (2026-07-27) added a Bible read surface for the
studio's language → translation → book → chapter → verse picker. It lives entirely in
`supagloo-nextjs`:

```
lib/youversion/{contracts,client,cache,bff}.ts
app/api/bible/{languages,translations,books,chapters,verses,passage}/route.ts
lib/studio/{scripture-data,scripture-picker}.ts
app/studio/_components/scripture-picker.tsx
```

**Why not a new `/v1/bibles*` surface on the api** (which is what the architecture would
say): the api does not load `YOUVERSION_APP_KEY` at all, so that route costs the api env
loader + the api compose block + root `.env.example` + root `tests/unit/env-example.test.ts`
+ `api-compose.test.ts`, and its DTOs would conventionally live in db-lib — i.e. a **db-lib
release + submodule bump + `DATABASE_LIB_REF` in two Dockerfiles**. nextjs already has
`YV_APP_KEY` as a REQUIRED boot var and compose already supplies it. One repo instead of
four, for a read-only, non-user-scoped metadata proxy with no DB and no business rules.
**Trade-off:** it deviates from design-delta §5.1 ("BFF holds no business logic") and adds a
NEXTJS→YouVersion edge §5.2 does not draw. Reversible — the client is pure with an injected
`fetch`, so lifting it into the api later is a move, not a rewrite.

**Why not `@youversion/platform-core`** (already a dependency, routes DO match live): read
its source, not its types. `src/client.ts` treats `response.ok` as success then branches on
`content-type` — a **204 with `content-type: text/html` and a zero-byte body** resolves to
`""`, so `.data` is `undefined`. `getBooks()` forwards only `canon` (no `page_size`, no
`fields[]`). Non-ok throws a plain `Error` whose message is redacted outside
`NODE_ENV=development`, so 401/404/422 stop being distinguishable.

## Live route facts (measured 2026-07-27, correcting the Step-5b estimates)

- **`page_size=*` + 1..3 `fields[]` returns the WHOLE collection in ONE request.**
  `/v1/languages?page_size=*&fields[]=id&fields[]=text_direction&fields[]=display_names`
  ⇒ 8583 records, 780 KB, 2.2 s. `/v1/bibles?language_ranges[]=*&page_size=*&fields[]=…`
  ⇒ 1472 bibles, 80 KB, 0.3 s. This kills the "172 requests" and "30 requests" walks.
- **`fields[]` is IGNORED on `/v1/bibles/{id}/books`** — 1 590 704 bytes, always. The
  server-side projection to `{usfm,title,canon}` (~3 KB) is the only thing keeping it off
  the wire. Cache it.
- **`/v1/bibles/{id}/books/{USFM}/chapters/{n}/verses` is the thin route** — 1.5 KB.
  `/books/{USFM}/chapters` is 78 KB (verses nested). `/v1/bibles/{id}/chapters` is 404.
- **`GET /v1/languages/{id}` EXISTS** (Step 5b said there was no single-language lookup)
  and resolves aliases: `arb` → `{"id":"ar",…}`.
- **204 = a language with zero Bibles.** Branch before parsing.
- **Direction: the API wins over `Intl`.** They disagree on 5 languages that have Bibles
  (`kby mfi rhg swb vgr` — API `ltr`, Intl `rtl`). 12 of the 1252 catalogue tags
  (`zh-Hant-TW`, `es-ES`, `pt-PT`, `ur-Latn`, …) have no `/v1/languages` record; those and
  only those fall back to `Intl.Locale().getTextInfo()` / `Intl.DisplayNames`.
- **English grant: 20 Bibles, ASV=12, BSB=3034, NO KJV.** The picker's ASV default is
  matched by ABBREVIATION in the live collection (never by id) so §9-Q10's
  "ids are never hardcoded" stays true; the manifest default stays BSB.
- **Never construct a USFM ref — echo `passage_id`.** The enumeration routes hand back
  exactly the string the passage route wants, which closes 34-E5's "USFM production is an
  unbuilt residual risk".

`lib/config/env.ts` is the ONLY file allowed to read `YV_APP_KEY`
(`tests/unit/boot-hardening.test.ts` D43.2 enforces it) — go through
`loadNextjsServerEnv()`.

The live contract is pinned in the real e2e lane by
`tests/e2e/bible-youversion-live.e2e.ts` (2 config edits to register). Deterministic
misbehaviour (204/401/404/422, pagination) is unit-tested with an injected fetch.

Related: [[task-34-e5-youversion-real-api]], [[kjv-bsb-generation-only]],
[[rtl-via-dir-auto-not-a-manifest-field]], [[gallery-not-filterable-by-book]].
