# Claude Design Review — Supagloo Wireframes

**Source:** Claude Design project `Supagloo: Scripture video studio`
Project ID: `4a1d0650-60d2-4a61-9e12-3ad53e53538a`
File: `Supagloo Wireframes.dc.html`
URL: https://claude.ai/design/p/4a1d0650-60d2-4a61-9e12-3ad53e53538a?file=Supagloo+Wireframes.dc.html

**Retrieval method:** `DesignSync` tool (`get_project`, `list_files`, `get_file`). The file is a single
"canvas mode" design doc (`design_doc_mode: canvas`) that embeds the *entire* turn-by-turn design
history as sequential `<section class="dv-turn" id="tN">` blocks in **descending** order (newest first).
`get_file` is capped at 256 KiB and the full file is larger, so the response is truncated partway through
older content — but because turns are ordered newest-first, all requested turns are reliably captured
before the truncation point. `WebFetch` on the project URL was also attempted as a fallback and returned
HTTP 403 (expected — this is an authenticated claude.ai/design page, not in WebFetch's allowed-URL
exceptions), so `DesignSync` was the only working path.

**Update (2026-07-17):** the user added **Turn 15** (public Gallery) to the project after the initial
Turns 7–14 retrieval. Turn 15 was pulled in a follow-up `get_file` call and is documented below — it
resolves the "Gallery screen not yet designed" gap noted in the original pass. At retrieval time the
truncation point had moved slightly earlier (now mid-Turn-4) to make room for Turn 15's content; this
doesn't affect anything in the originally-requested 7–14 range, which remains fully captured.

Each numbered "turn" in the doc is one prompt/response round in the design conversation; each turn
contains one or more lettered "options" (e.g. `14a`, `14b`, `14c`) which are alternative or complementary
screens/components explored in that round. Options frequently cross-reference each other (e.g. "opens
from the version chip in 13b").

## Visual language / design system (applies to all turns below)

Font stack: `Anton` (display headings), `Barlow` / `Barlow Semi Condensed` (UI text), `Zilla Slab`
(body/serif copy, scripture text), `Kalam` (wireframe annotations only, not real UI).

Theme is a CSS-variable light/dark pair driven by `prefers-color-scheme`, branded around YouVersion's
palette:
```css
:root{--sg-bg:#ffffff;--sg-fg:#0b0b0b;--sg-dim:#6b6b6b;--sg-panel:#f6f5f3;--sg-panel2:#efedea;
      --sg-line:rgba(0,0,0,.10);--sg-line2:rgba(0,0,0,.17);
      --sg-red:#c0392b;--sg-brown:#6d3b26;--sg-gold:#c99a3f;--sg-cream:#f4e6c8}
@media (prefers-color-scheme:dark){:root{--sg-bg:#050505;--sg-fg:#fafafa;--sg-dim:#9a9a9a;
      --sg-panel:#111110;--sg-panel2:#1a1918;--sg-line:rgba(255,255,255,.11);--sg-line2:rgba(255,255,255,.20)}}
```
Primary CTA gradient: `linear-gradient(150deg,#d4a24c,#c0392b 55%,#6d3b26)` (gold → red → brown), used
on every primary button throughout the app. Logo mark is a simple cross glyph in a rounded-square badge
with that gradient. App chrome (studio/editor) is a "mono skin" — near-black/near-white surfaces with the
same red/gold accent used sparingly for active states, live indicators, and primary actions.

---

## Turn 15 — Public gallery (id `t15`)

**15a — Gallery.** The `/gallery` screen (public, unauthenticated — nav link confirmed since Turn 7,
layout now designed):

- **Nav:** same chrome as the rest of the app; "Gallery" is the active link (alongside "Workspace" /
  "How it works" and the signed-in user pill).
- **Header:** eyebrow "COMMUNITY GALLERY", headline "SCRIPTURE, SHARED.", subhead "Videos made public by
  creators around the world. Upvote the ones that move you.", primary CTA "＋ Share yours" (top-right —
  presumably opens the not-yet-designed publish-to-gallery dialog referenced in this turn's own "try
  next" list, i.e. the `POST .../gallery` action from a completed render).
- **Filter row:** a segmented sort control — **Most popular** (active/default), **Newest**, **Trending**
  — plus an **"All books ▾"** filter (Bible book) and a **"🔍 Search"** affordance.
- **Grid:** 4-column card grid. Each card:
  - Thumbnail (16:9-ish crop of a 9:16 source, gradient-art placeholder standing in for an actual video
    frame), a play-button overlay, the video title in large display type (e.g. "LET THERE BE LIGHT"), the
    scripture reference below it (e.g. "GENESIS 1:1–4"), and a `mm:ss` duration badge bottom-right.
  - The **#1 card only** additionally shows a "🏆 #1" badge (top-left); ranks #2+ show a plain "#N" badge
    or no rank badge at all lower in the grid.
  - Below the thumbnail: creator avatar-initials + handle + **translation code** (e.g. "@maryk · KJV",
    "@davidl · NIV", "@graceh · ESV", "@joelt · NLT", "@elip · NASB" — the mock shows a spread of
    translations, not just KJV), and an **upvote control** (`▲ 2.4k`) — solid/filled red when the viewer
    has already upvoted (card 1 in the mock), otherwise an outlined pill.
  - "Load more" pagination button below the grid (no infinite scroll / page numbers shown).
- **Explicitly flagged as NOT designed yet** (from the turn's own "try next" suggestions): a gallery
  item's detail/watch page, the "Share yours" publish-to-gallery dialog, and a creator profile page
  (their public videos). Treat these as open follow-on screens, not yet speccable from wireframes.

**Data/entities implied:** a gallery entry has: title, scripture reference, **translation code** (shown
per-item — the mock's variety of translations, KJV/NIV/ESV/NLT/NASB, is illustrative wireframe content,
not necessarily a literal requirement — cross-check against the actual translation(s) the system supports
for generation), duration, creator (handle + avatar), and an **upvote count** with per-viewer
upvoted/not-upvoted state (implies a join/vote table, not just a counter, to prevent duplicate upvotes and
to render the viewer's own vote state). Sorting/filtering needs: by popularity (upvote count), by recency,
by a "trending" metric (likely time-decayed popularity), by Bible book, and free-text search. Rank badges
(🏆 #1 particularly) imply the "Most popular" sort is also used to compute a leaderboard-style top slot,
not just a stable sort order.

---

## Turn 14 — Publish · versions · render (id `t14`)

Three options, all layered on top of the `/studio/[id]` editor from Turn 13b.

**14a — Publish v0.0.2 flow.** A 3-step modal sequence triggered by the studio's "Publish" button:
1. *Review & confirm*: shows version transition (`v0.0.1 → v0.0.2`, "merges to main"), an editable
   commit message + auto-generated summary line, and a changed-files list (`M src/scenes/Shelter.tsx`,
   `M src/Composition.tsx`, `M captions/psalm-23.json`) styled like a git diff summary. Primary action:
   "Publish v0.0.2 ▸".
2. *Publishing log*: live checklist — "Committed to v0.0.1" → "Pushed branch to origin" → "Opened PR #7 →
   main" → "Merging PR & tagging v0.0.2…" (spinner) → "Pull main · cut branch v0.0.3" (pending). Footnote:
   "Your next edits continue on a fresh v0.0.3 branch."
3. *Published*: success state ("v0.0.2 PUBLISHED."), "Merged to main and tagged. You're now editing on
   v0.0.3." Actions: "View on GitHub ↗" and "Render & share ▸".

Confirms the versioning model: **every publish = commit → PR → merge to `main` → auto-branch the next
`v0.0.x` working branch.** `main` always holds the latest published/live version; users always edit on an
unpublished working branch one version ahead.

**14b — Version-branch dropdown.** Opens from the version chip in the studio header. Lists version
branches newest-first: current working branch (e.g. `v0.0.3`, "working branch · uncommitted edits", gold
dot = unsaved changes), the live/published one tagged `LIVE ON MAIN` with green badge and relative
publish time + change summary, older ones with a "restore" action, and a `v0.0.0` "Empty template" base.
Header action: "⇄ Compare" (diff two versions — not designed yet). Footnote: "main always holds the
latest published version."

**14c — Render-progress overlay.** A modal covering the dimmed/blurred studio while Remotion renders on
Railway. Shows: mini vertical preview thumbnail with the current caption text, render label
("RENDERING · v0.0.2"), project title, output spec ("1080×1920 · 9:16 · 30fps · H.264"), a progress bar
with frame counts ("612 / 840", "73% · ~14s remaining · on Railway worker"), and a stage checklist
("Bundled composition" ✓ → "Synthesized narration & music" ✓ → "Encoding video" (spinner) → "Upload &
finalize share link" (pending)). Actions: "Cancel render", "Run in background" (user can keep editing
while render continues).

**Data/entities implied:** a project has an ordered set of version branches (`v0.0.0`, `v0.0.1`, ...)
each with a status (working/uncommitted, published/live-on-main, archived), a commit message + summary,
a changed-file list, a "published Nm ago" timestamp; a render job has a status/stage enum (bundling →
synthesizing audio → encoding → uploading), progress fraction, output format fields (resolution, aspect
ratio, fps, codec), and can run in background (async, notifiable) or be canceled.

---

## Turn 13 — Existing-repo tab + Studio (id `t13`)

**13a — New project · "use existing empty repo" tab.** Second tab of the New-Project wizard's step 1
(companion to 12a). Toggle between "Create new repo" / "Use existing empty repo". Repo search box, a list
of the user's GitHub repos where **empty repos are selectable** (badge `EMPTY`, radio-selected) and
**non-empty repos are disabled** with badge `NOT EMPTY` and hint "Already contains a project". A
"Project name" field defaults to the repo name. CTA: "Scaffold into this repo →".

**13b — `/studio/[id]` editor.** The main Remotion editor all wizards open into. Full layout:

- **Top bar:** back chevron, logo, project name (editable, pencil icon), repo path
  (`ashsrinivas/psalm-121`) with GitHub icon, a **version-branch chip** (`⑂ v0.0.1`, gold dot = unsaved,
  click to open the 14b dropdown), "Edited 2m ago · not committed" status text, an aspect-ratio switcher
  (`9:16` / `16:9` / `1:1`), a "⤓ Commit" button, a "Publish v0.0.2 ▸" primary button, and a user avatar.
- **Left panel — composition tree:** the Remotion composition name + resolution (`🎬 Psalm121 ·
  1080×1920`), an `AudioTrack` node, per-scene nodes (`▦ Scene 01 · Shelter`, `Scene 02 · Still Waters`,
  `Scene 03 · Valley`, `Scene 04 · Table`), an `EndCard` node, and "＋ Add scene".
- **Center — player + timeline:** checkerboard-backed 9:16 preview frame rendering the current scene
  (scene badge "SCENE 01 / 04", the scripture text overlaid at bottom, reference caption "PSALM 23:1 ·
  KJV"), a transport bar (play, elapsed/total time, scrub bar, volume, fps), and a timeline with
  **VISUAL** (per-scene colored blocks with scene names), **VOICE** (waveform bars = narration audio),
  **MUSIC** (single labeled bed, e.g. "Orchestral · Adagio"), and **SCRIPT** ("Captions ON · 4 cues")
  tracks.
- **Right panel — scene inspector** (for the selected scene): **SCRIPT** (the verse text quoted),
  **VISUAL PROMPT** (an editable AI image-gen prompt textarea, marked "→ AI", with "↻ Reroll visual"),
  **NARRATOR VOICE** (a whole-video-scoped voice-description field, e.g. "warm, weathered baritone —
  unhurried & reverent"), an **On-screen captions** toggle (default on), and a **Duration** field (e.g.
  "7.0s").

**Data/entities implied:** Project { id/slug, name, repo (owner/name), current branch, resolution/aspect
ratio, edited/committed timestamps }. Composition { scenes: ordered list, audioTrack, endCard }. Scene {
order, name, scriptText (verse text + reference + translation), visualPrompt (AI prompt string),
durationSeconds, captionsEnabled, generated image/video asset reference }. Narration is voice-description
text scoped to the whole video (not per-scene) → implies a single narrator-voice field per project/version
plus per-scene script text that gets synthesized against it. Music is a single background bed per
project/version (name/style label, e.g. genre + tempo descriptor) rather than per-scene.

---

## Turn 12 — Project wizards (id `t12`)

**12a — New project wizard.** 3-step modal flow launched from "New project" (10a):
1. *Choose repo* (Step 1/3): tab "Create new repo" (active) vs. "Use existing empty repo" (→ 13a). Fields:
   "New repository name" (`ashsrinivas / psalm-121`, with a Private/public visibility toggle) and
   "Project name" (defaults to repo name). CTA: "Create & scaffold →".
2. *Provisioning log* (Step 2/3): "Scaffolding PSALM-121…", checklist — "Created repo
   ashsrinivas/psalm-121" ✓ → "Cloned to Railway workspace" ✓ → "Scaffolded Remotion project" ✓ →
   "Checked out v0.0.0 · committed initial files" ✓ → "Pushed → opened & merged PR into main" ✓ →
   "Pulled main · branching v0.0.1 · pushing…" (spinner) → "Opening studio" (pending). Note: "main stays
   clean & released; you always edit on the newest v0.0.x branch."
3. *Ready/redirect* (Step 3/3): "PROJECT READY.", "psalm-121 is scaffolded and pushed. You're editing on
   branch v0.0.1.", shows target URL `supagloo.com/studio/psalm-121`, CTA "Open in studio →",
   auto-redirect note.

**12b — Import project wizard.** 2-step flow for adopting an existing GitHub repo that already contains a
Supagloo project:
1. *Select repo* (Step 1/2): repo search + list (shows "Updated 5 days ago · latest branch v0.2.3" style
   metadata). CTA: "Import & verify →".
2. *Verifying* (Step 2/2): checklist — "Cloned to Railway workspace" ✓ → "Found valid Remotion project ·
   remotion.config.ts" ✓ → "Latest version branch v0.2.3" ✓ → "Checking out v0.2.3 · opening studio…"
   (spinner). Shows target URL.
3. *Error variant — "NOT A SUPAGLOO PROJECT"*: shown when the chosen repo has no `remotion.config.ts` /
   version branch. Explains why, offers "← Choose another" or "Start new project".

**Data/entities implied:** repo visibility (private/public) is a field at creation time. A project is
"verified" as Supagloo-compatible by presence of `remotion.config.ts` and at least one `vN.N.N` branch.
Import flow reads "latest version branch" off the repo directly (branch-naming convention `v<major>.<minor>.<patch>`,
not strictly `v0.0.x` — 12b's example is `v0.2.3`, so version numbers can climb past the 0.0.x pattern seen
in the fresh-scaffold examples).

---

## Turn 11 — Setup wizards (id `t11`)

**11a — First-time setup wizard.** Shown once after a user's very first sign-in, as a dimmed/backdropped
modal sequence (4 steps + welcome = effectively 5 screens):
- *Welcome*: "WELCOME TO SUPAGLOO, ASH." Lists the three connectable accounts with requirement badges:
  **GitHub — "stores your projects" — REQUIRED**; **OpenRouter.ai — "premium models" — OPTIONAL**;
  **Gloo AI — "faith-aligned models" — OPTIONAL**. CTA "Get started →".
- *Connect GitHub* (Step 2/4, REQUIRED): explains why ("every project is a GitHub repo — the source of
  truth… cloned to a temporary Railway workspace when opened, pushed back on save"), a permissions list
  ("✓ Read & write repositories you choose", "✓ Create new repos for new projects", "— Never touch repos
  you don't select"), button "Authorize with GitHub" (opens GitHub OAuth in new tab). No skip option (
  required).
- *Connect OpenRouter* (Step 3/4, RECOMMENDED): "ADD PREMIUM MODELS", model chips (GPT-4o, Claude Sonnet,
  Gemini 2.5, "+300 more"), explains **PKCE OAuth** ("you approve on OpenRouter and no key is ever pasted
  here"), button "Connect with OpenRouter", "Skip for now →" link.
- *Gloo credentials* (Step 4/4, RECOMMENDED): "GLOO AI CREDENTIALS", explanation ("Paste the client ID &
  secret from your Gloo developer dashboard. Stored encrypted — used only to mint short-lived tokens."),
  two fields **CLIENT ID** and **CLIENT SECRET** (masked, eye-toggle to reveal), "Save & finish" / "Skip",
  link "Open Gloo dashboard ↗".
- *Done*: "YOU'RE ALL SET.", recap checklist of what got connected/skipped, CTA "Go to my workspace →".

**11b — Standalone: Connect GitHub.** Same GitHub-connect screen re-used as a single-step modal (no
wizard progress bar) launched later from the Profile page (10b) — has a close (✕) button instead of
skip/back.

**11c — Standalone: Connect OpenRouter.** Same OpenRouter screen re-used standalone, adds an explicit PKCE
security callout box ("🔒 PKCE means the token is exchanged directly between your browser and
OpenRouter — Supagloo never sees your password or a long-lived key"), no skip (close button instead).

Note: "11d" (standalone Gloo) was explicitly *not* designed as a separate screen — the design decision was
that the Gloo credential form lives inline in the Profile page (10b) instead of a modal.

**Data/entities implied — three provider connections per user:**
- **GitHub**: OAuth connection; fields — connected boolean, username/handle, accessible-repo count,
  granted scope is repo-level (read/write on selected repos only, not full account).
- **OpenRouter**: PKCE OAuth connection; fields — connected boolean, masked API key display (e.g.
  `sk-or-••••••4f2a`), remaining credit balance (e.g. "$18.40 credit remaining").
- **Gloo AI**: client-credentials connection (NOT a redirect OAuth flow) — fields — `client_id`,
  `client_secret` (stored encrypted, used to mint short-lived tokens), connected/linked boolean.

---

## Turn 10 — Workspace overview + profile (id `t10`)

**10a — Workspace overview.** The signed-in home page (landed on after sign-in / "Start creating").
- **Nav:** logo, "Workspace" (active) / "Gallery" / "How it works" links, user profile pill
  (avatar-initials "AS", name, chevron — opens a dropdown, per 9a/9b's pattern).
- **Header row:** "YOUR WORKSPACE" / "WELCOME BACK, ASH.", buttons "＋ New project" (→ opens 12a) and
  "Import repo" (→ opens 12b).
- **Provider status strip:** three cards for GitHub / OpenRouter / Gloo AI, each showing connected state
  (green dot + "@handle · connected" / "Premium models · connected") or, for Gloo AI here, a **not-linked
  state** ("Not linked — add credentials" in red, "Link ▸" action) — i.e. Gloo AI is commonly left
  unconfigured and the workspace surfaces that as an actionable nudge.
- **Recent projects grid** (3-column card grid), sorted "by last opened": each **project card** shows a
  gradient/rendered-frame thumbnail, a status badge (**RENDERED** or **DRAFT**), title (e.g. "Let There Be
  Light"), repo path (`ashsrinivas/genesis-light`), "Opened Nh/days ago", current branch name (`main`),
  and an "Open ▸" action. A dashed "＋ New project" card is always last. Footnote: "Projects live in your
  GitHub repos — Supagloo clones them to a temporary workspace when you open one… Nothing is stored on
  our servers."

**10b — User profile & connections.** `/profile`-style page:
- **Header:** avatar, name "ASH SRINIVAS", `ash@supagloo.com · signed in with YouVersion`, "Sign out"
  button (YouVersion-branded).
- **Connected accounts** section, one card per provider:
  - **GitHub** (connected): badge "Connected", description of what it's used for, a chip showing
    `@ashsrinivas · 12 repos accessible`, "Disconnect" action.
  - **OpenRouter.ai** (connected via PKCE): badge "Connected" + "PKCE OAUTH" tag, masked key
    (`sk-or-••••••4f2a`) and `$18.40 credit remaining`, "Disconnect" action.
  - **Gloo AI** (not linked): badge "Not linked" + "CLIENT CREDENTIALS" tag, **inline** `CLIENT ID` /
    `CLIENT SECRET` input fields (masked, eye-toggle), "Save & verify" action, "Open Gloo dashboard ↗"
    link.
- Footer note: "🔒 All tokens & secrets are encrypted at rest. Supagloo is 100% free — you only ever pay
  your own model providers."

**Data/entities implied:** User { id, name, email, authProvider: "YouVersion", avatarInitials }.
ProviderConnection { userId, provider: github|openrouter|gloo, status: connected|not_linked, connectedAt,
provider-specific fields as above }. Project card summary fields: title, repoOwner/repoName, thumbnail
(from last render or a generated placeholder), status: draft|rendered, lastOpenedAt, currentBranch. The
explicit statement "Nothing is stored on our servers" (project content) is an architecturally significant
constraint — the DB likely stores only metadata/pointers (repo URL, branch, provider tokens, project
cards), not the Remotion source/media itself, which lives in the user's GitHub repo + ephemeral Railway
workspace.

---

## Turn 9 — Signed-in header + mobile landing (id `t9`)

**9a — Signed-in header variant of the landing page.** Same landing as Turn 7/8 but: nav's sign-in button
is replaced with Ash's profile pill (avatar, name, chevron); nav gains a third link "Your videos"; hero
CTA changes from "Sign in with YouVersion" to "＋ Start creating"; a secondary "▶ Watch the Genesis demo"
button remains. Everything else (featured demo card, "OR START YOUR OWN" 3-up: Verse of the Day / From a
passage / Blank canvas, footer) is unchanged from the signed-out landing.

**9b — Mobile/responsive landing.** 390px-wide phone frame: status bar, hamburger nav (no inline links),
stacked hero (smaller Anton headline), full-width "Sign in with YouVersion" button, full-width "Watch the
Genesis demo" outline button, "100% FREE" badge, then the demo card and the three starter-option cards
stacked vertically instead of in a row. Footer center-aligned.

**Data/entities implied:** none new — confirms "Your videos" as a nav destination (likely the personal
gallery / rendered-outputs list, distinct from the public Gallery) and confirms the three "start" entry
points (verse-of-the-day, passage picker, blank canvas) as first-class project-creation origins, which
probably need to be recorded on a Project as a `createdFrom` / `origin` field (e.g. `votd | passage |
blank | demo | import`).

---

## Turn 8 — Landing page · sign-in in header (id `t8`)

**8a — Landing page, sign-in moved to header.** Iteration on the signed-out landing: "Sign in with
YouVersion" relocates from the hero to the nav bar (top-right), rendered as a smaller pill button (icon +
"Sign in with YouVersion" text) rather than the large hero CTA. Hero keeps only the "▶ Watch the Genesis
demo" button plus the "100% FREE" badge line. Tagline under the eyebrow text changes to "Pick a verse —
Supagloo storyboards it, narrates it in the voice you describe, and scores it into a share-ready short.
Sign in with your YouVersion account to begin." Rest of page (featured demo, starter options, footer)
identical to Turn 7.

---

## Turn 7 — Landing page · supagloo.com skin (id `t7`)

**7a — Landing page (first full pass).** Establishes the public marketing/start page at supagloo.com:
- **Nav:** logo + "Supagloo" wordmark, "How it works" / "Gallery" links (no auth control yet in this
  variant — sign-in lives in the hero).
- **Hero:** eyebrow "SCRIPTURE VIDEO STUDIO · BUILT ON YOUVERSION", headline "TURN SCRIPTURE INTO
  CINEMATIC VIDEO." (gradient-text second line), subhead explaining the pitch, a large
  "Sign in with YouVersion" primary CTA (YouVersion "HOLY BIBLE" badge icon + label) and a "▶ Watch the
  Genesis demo" secondary CTA, a "✦ 100% FREE" badge plus "No credit card · Bring your own Gloo AI &
  OpenRouter.ai keys — mix free & premium models" caption.
- **Featured demo section** ("⚡ START IN ONE CLICK — NO BLANK PAGE"): a large card for a pre-built
  Genesis 1:1–4 demo — cosmic gradient thumbnail with a play button overlay, "FEATURED STARTER SCRIPT" /
  "GENESIS · LET THERE BE LIGHT" title, description, attribute chips ("🔊 Dramatic baritone", "🎬 Cosmic
  visuals", "🎻 Orchestral", "⏱ 0:32 · 4 scenes"), CTAs "▶ Start from this demo" and "Preview scenes ▸".
- **"OR START YOUR OWN"** — three equal cards: **Verse of the Day** ("Today's YouVersion verse,
  auto-loaded"), **From a passage** ("Pick any book, chapter & verses"), **Blank canvas** ("Build the
  flow from scratch").
- **Footer:** copyright, "Built on the YouVersion Platform".

**7b — Brand kit: theme, YouVersion auth & favicon.** A component/spec sheet (not a real screen):
- Light/dark theme swatches side by side, confirming the token set in the header CSS.
- Accent palette swatches: **Red `#c0392b`**, **Brown `#6d3b26`**, **Gold `#c99a3f`**.
- Signed-out nav button spec: "Sign in with YouVersion" pill with the YouVersion "HOLY BIBLE" logo badge.
- Signed-in profile dropdown spec: avatar+name nav pill opens a dropdown showing avatar, name, email
  (`ash@supagloo.com`), menu items **"Your videos"** and **"Account settings"**, and a "Sign out of
  YouVersion" action (styled with the YouVersion badge).
- Favicon fix spec: documents a Safari clipping bug and the fix — ship `favicon.svg` + `apple-touch-icon.png`
  (180px) + `favicon-32.png` as a full-bleed rounded-square mark instead of a clipped/off-center one.
  (Matches the `favicon/` files actually present in the design project's file list.)

**Data/entities implied:** confirms **YouVersion is the sole identity/auth provider** (native OAuth,
"Sign in with YouVersion" / "Sign out of YouVersion") — separate and prior to the GitHub / OpenRouter /
Gloo AI *service connections* introduced in Turns 10–11. Profile dropdown's "Account settings" is presumably
the destination for the Turn 10b connections page. Confirms a public, unauthenticated `Gallery` nav
destination exists site-wide (rendered videos, browsable without sign-in) — its own screen content wasn't
reached within turns 7–14, so its layout/fields are not yet documented here.

---

## Consolidated data-model implications (for schema design)

Cutting across turns 7–14, the following entities/fields are implied by the UI and should inform DB schema:

- **User**: id, display name, email, avatar (initials-based in mockups), `authProvider: "youversion"`
  (external YouVersion account id/token).
- **ProviderConnection** (1\:many off User): `provider` ∈ {github, openrouter, gloo}; per-provider fields:
  - github: oauth token/scope, `login`/handle, accessible repo count (derived, not stored)
  - openrouter: PKCE-obtained token (masked display `sk-or-••••••NNNN`), credit balance (likely fetched
    live, not stored)
  - gloo: `client_id`, `client_secret` (encrypted at rest), used to mint short-lived tokens (not stored)
  - common: `status` (connected / not_linked), `connectedAt`
- **Project**: id/slug, name, `repoOwner`/`repoName` (GitHub), visibility (private/public at creation),
  `createdFrom` origin (verse-of-the-day | passage | blank | demo | import), thumbnail, status
  (draft/rendered), `lastOpenedAt`, `currentBranch`.
- **VersionBranch** (1\:many off Project): semantic version string (`v0.0.0`, `v0.0.1`, …, observed going
  as high as `v0.2.3` for older/imported projects), state (working/uncommitted, published/live-on-main,
  archived), commit message + auto-summary, changed-files list, `publishedAt`, PR number/link.
- **Composition** (effectively 1:1 with a VersionBranch's checked-out state): resolution, aspect ratio
  (9:16 / 16:9 / 1:1), duration; contains an ordered list of **Scenes**, one **AudioTrack** (narration),
  one background **Music** bed, and one **EndCard**.
- **Scene**: order/index, name/label, `scriptText` (verse text + reference + translation code, e.g. "PSALM
  23:1 · KJV"), `visualPrompt` (AI image/video-gen prompt, user-editable + "AI"-rerollable), generated
  visual asset reference, `durationSeconds`, `captionsEnabled` (bool).
- **NarratorVoice**: a single voice-description text field scoped to the whole project/version (not
  per-scene) — implies narration synthesis is driven by one voice descriptor across all scenes.
- **RenderJob**: status/stage enum (bundling → synthesizing narration/music → encoding → uploading),
  progress fraction + frame counts, output spec (resolution, aspect ratio, fps, codec — e.g. 1080×1920,
  30fps, H.264), `runInBackground` flag, cancelable, notifies user on completion, produces a shareable
  output/link.
- **GalleryItem** (now designed — Turn 15): title, scripture reference, translation code, duration,
  creator (handle/avatar), thumbnail, sort-relevant metrics (upvote count, publish time, a "trending"
  score). Needs a companion **GalleryUpvote** join entity (userId × galleryItemId, unique) so per-viewer
  upvote state and duplicate-prevention are possible, not just a raw counter. Distinct from "Your videos"
  (authenticated, personal — the user's own renders, published or not).

## Open gaps / notes for downstream steps

1. ~~**Gallery screen itself** not yet designed~~ — **Resolved by Turn 15** (see above). Remaining
   sub-gaps *within* the gallery flow, per Turn 15's own "try next" list: the item detail/watch page, the
   "Share yours" publish dialog, and a creator profile page are still undesigned.
2. The version-branch **"⇄ Compare"** action (14b) is referenced but not yet designed as a real screen.
3. **11d** (a standalone Gloo AI connect modal) was explicitly *not* built — the Gloo form only exists
   inline on the Profile page (10b) and inside the first-time wizard (11a step 4). Don't design a
   standalone Gloo OAuth-style modal; it should match the inline credentials-form pattern.
4. Two "start a project" surfaces exist with the same three options (Verse of the Day / From a passage /
   Blank canvas) — the marketing landing (7a/8a/9a) and, per 10a, "New project" opens the repo-first
   wizard (12a) instead. It's not fully clear from turns 7–14 alone how the verse-selection step
   (choosing VOTD/passage/blank) composes with the repo-creation wizard (12a/13a) — likely the verse
   choice happens first (on the landing or in a pre-step), then feeds into project scaffolding, but the
   exact screen sequence linking them isn't shown in this turn range.
5. Import imagery (12b) shows version strings like `v0.2.3`, i.e. imported/existing projects aren't bound
   to the `v0.0.x` scaffold sequence — version numbering is presumably free-form semver, only *new*
   projects start at `v0.0.0`.
6. Turn 15's gallery cards show a spread of translations (KJV, NIV, ESV, NLT, NASB) as placeholder
   content — this is wireframe flavor, not a confirmed requirement that all five be supported. Cross-check
   against whatever translation(s) the generation pipeline actually supports (see design-delta.md).
