---
name: studio-inspector-requires-scenes
description: The studio Inspector — and therefore the scripture picker and the read-only project-passage line — does not exist until the storyboard has scenes, so nothing about a freshly scaffolded project's passage is observable before a generation
metadata:
  type: constraint
---

`app/studio/_components/studio-app.tsx` branches on
`state.storyboard.scenes.length === 0`: the empty branch renders `StudioEmpty` (which carries
`generate-storyboard`), and `SceneTree` / `PlayerPanel` / `SceneInspector` / `Timeline` exist
**only** in the other branch. `ScripturePicker` is mounted inside `SceneInspector`, gated
further on `aiEnabled = Boolean(project.manifest)`, and 13b's read-only `project-passage` line
lives inside the picker.

So on a freshly scaffolded project (`scenes: []`) there is **no** Inspector, no
`scripture-picker`, and no `project-passage` — even though `manifest.scripture` is present in
git and hydrated in state. Verified 2026-07-30: a spec read `project-passage` right after
`studio-frame` appeared and got `""`, which reads exactly like the studio having dropped the
passage. It had not; there was no Inspector to draw it in.

**Consequence for specs.** Any assertion about the project's origin passage, or about the
picker being bound rather than showing `select book` / `select cha` / `select ve`, must come
**after** the first generation. That ordering is not a workaround — it is the faithful
reproduction, because the Inspector after generating is the only place the reference line is
drawn and the only place a user ever saw the reported bug.

Also note `textOfTestId`-style helpers return `""` for a missing element rather than throwing,
so a missing element and an empty one are indistinguishable. Wait for the testid first.

This is by design (D5 put the reference line above the picker, per wireframe 13b), not a gap
to close — but it does mean a project created with a passage shows that passage nowhere until
it has scenes.

Related: [[e2e-cascade-select-needs-the-option-not-the-element]],
[[wizard-passage-must-travel-as-usfm]], [[genesis1-studio-share-bugs-built]],
[[studio-hydration-commit-wired-nextjs]].
