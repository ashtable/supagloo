---
name: grep-shell-function-eats-bre-alternation
description: `grep` in this environment is a shell function that silently fails BRE alternation (`\|`) and `-c ""` — use /usr/bin/grep for anything non-trivial
metadata:
  type: constraint
---

`grep` in Bash tool calls here resolves to a **shell function** from
`~/.claude/shell-snapshots/snapshot-zsh-*.sh` (check with `type grep`), not to
`/usr/bin/grep`. It does not behave like BSD/GNU grep:

- `grep -n "Foo\|Bar" file` → **no output and no error**. BRE alternation is not
  supported, so the pattern silently matches nothing.
- `grep -c "" file` → no output, exit 1.
- `grep -rln "Foo" dir/` works, which is what makes this dangerous: some invocations
  behave normally, so a silent zero-hit reads as a real answer.

**This cost real time and nearly caused a wrong conclusion**: a `\|`-alternation search of
`supagloo-database-lib/src/schemas.ts` for `GalleryMakingOfSchema` returned nothing, which
looked like "the released db-lib schemas are missing". They were there at line 1621.
`git show --stat` on the commit is what exposed the lie.

**Rule: use `/usr/bin/grep` explicitly for any pattern beyond a plain literal**, and never
treat a zero-hit grep as proof of absence without a second, differently-shaped check
(`git show`, `ls`, `-rln` over the directory).
