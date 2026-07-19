# CLAUDE.md

## Worktrees are mandatory

**ALL work must be done in a new git worktree.** Other agents work in this
codebase concurrently, so editing the primary checkout directly will collide
with their changes.

Before making any edit:

```sh
git worktree add .claude/worktrees/<short-branch-name> -b <short-branch-name>
```

Do every edit, build, test and commit inside that worktree. When the work is
finished, merge the branch back into `main`, then remove the worktree and delete
the branch:

```sh
git worktree remove .claude/worktrees/<short-branch-name>
git branch -d <short-branch-name>
```

`.claude/worktrees/` is git-ignored, so worktrees never show up as untracked
files. Never remove a worktree you did not create — another agent may still be
using it; check commit timestamps and file mtimes before assuming one is idle.

A worktree starts without `node_modules`; run `npm ci` in it before building or
testing.

`main` moves while you work. Expect the merge back to conflict with whatever
else landed, and re-run the gate **after** merging, not just on the branch — a
green branch plus a green `main` does not make a green merge result.

## Close the ticket when the work lands

Work that resolves a GitHub issue is not finished until that issue is closed.
Once the branch is merged into `main`, close the issue it resolves and reconcile
its labels so they describe what the change actually turned out to be — add the
ones that now apply, and remove any the work proved wrong. Issues left open
behind merged code make it impossible to tell what is still outstanding, and
stale labels send the next person to the wrong part of the codebase.

Reference the issue number in the commit subject (`… (#92)`) so the ticket and
the commit can be found from each other.

If the work has no ticket, do not open one just to close it. If it resolves only
part of a ticket, leave the ticket open and say in a comment what is left.

## Project

BangerBox is an offline-first, browser-based DAW/sequencer/sampler shipped as an
installable PWA. The binding specification is [docs/todo/\_spec.md](docs/todo/_spec.md);
section references such as §8.5.7 point into it.

## Commands

| Task            | Command                                           |
| --------------- | ------------------------------------------------- |
| Dev server      | `npm run dev`                                     |
| Unit tests      | `npm test`                                        |
| Type check      | `npm run type-check`                              |
| Lint            | `npm run lint`                                    |
| Formatting      | `npm run format:check` / `npm run format`         |
| Repo invariants | `npm run verify` (deps, language, stubs, orphans) |
| Browser smoke   | `npm run test:e2e` (hardcodes port 5199)          |

Run the full gate before committing: `type-check`, `lint`, `test`, `format:check`
and `verify`.

`npm run format:check` matters more than it looks. Nothing else runs Prettier —
no pre-commit hook, and a local `git merge` never checks formatting — so
unformatted code reaches `main` silently and the next branch inherits the drift.

### What `npm run verify` does and does not cover

`verify` is four scripts: `check:deps` (the dependency surface matches the
closed §2.2 matrix), `check:lang` (no American spellings outside the allowlist),
`check:stubs` (no open `STUB(phase-N)` tags, and no phase deferrals written as
prose) and `check:orphans` (§3.4 orphan-proofing).

`check:orphans` parses `src` with the TypeScript compiler API and fails on any
runtime export that no non-test module imports. It uses the compiler rather than
a grep because of barrels: `src/**/index.ts` re-exports with `export { X } from`
and `export *`, so a textual search finds a hit inside the barrel and every
orphan behind one launders itself clean. Re-exports are therefore modelled as
conditional edges — a barrel only counts as using `X` once something else uses
the barrel's own `X`. Exports that only a `*.test.ts(x)` file imports are
reported as orphans and marked as such, since a helper exported purely to be
tested is the case §3.4 exists to catch. Genuinely defensible ones go in
`scripts/check-orphans.allowlist.json` with a reason, in the same shape as the
`check-lang` and `check-stubs` allowlists; a stale entry there also fails the
gate, so the allowlist cannot quietly drift out of date.

Two kinds of entry are defensible, and the reason string has to say which. The
first is a pure helper its own module calls internally, exported so a test can
reach the arithmetic directly instead of through a rendered component or a live
audio graph — name the internal caller, so the claim can be checked. The second
is a finished implementation no UI reaches yet, where an open issue already
tracks the gap — cite it, and expect the entry to go when that issue closes.
Reaching for the allowlist for any other reason means the export is the
speculative kind §3.4 exists to catch: delete it, or wire it up.

One trap when reading the report: the `(imported only by tests)` annotation is
computed per declaring module, so a symbol a test imports **through a barrel**
is recorded against the barrel and shows up unannotated, looking like it is
referenced nowhere at all. The finding is still correct; only the label is
misleading. Grep the name across `src` before concluding something is dead.

What it still cannot see: `export type` and `export interface` are skipped
deliberately, because a type has no runtime existence and flagging types would
bury the real signal. It also cannot judge anything reached dynamically — a
namespace import, a bare `import('./x')` or a string-keyed lookup marks the
whole target module as consumed rather than risk a false accusation, so an
orphan hiding behind one of those will pass. It reasons about export _names_,
not values, so an export that is imported and then never called still counts as
used. And it says nothing about whole modules that are unreachable while their
exports all reference each other.

Be sceptical of any hand sweep that reports nothing: `grep -P` is unavailable on
this repo's Git Bash, so a `-P` pattern fails silently and reads as a clean
result.
