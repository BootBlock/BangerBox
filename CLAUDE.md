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

| Task            | Command                                        |
| --------------- | ---------------------------------------------- |
| Dev server      | `npm run dev`                                  |
| Unit tests      | `npm test`                                     |
| Type check      | `npm run type-check`                           |
| Lint            | `npm run lint`                                 |
| Formatting      | `npm run format:check` / `npm run format`      |
| Repo invariants | `npm run verify` (deps, language, stub checks) |
| Browser smoke   | `npm run test:e2e` (hardcodes port 5199)       |

Run the full gate before committing: `type-check`, `lint`, `test`, `format:check`
and `verify`.

`npm run format:check` matters more than it looks. Nothing else runs Prettier —
no pre-commit hook, and a local `git merge` never checks formatting — so
unformatted code reaches `main` silently and the next branch inherits the drift.

### What `npm run verify` does and does not cover

`verify` is exactly three scripts: `check:deps` (the dependency surface matches
the closed §2.2 matrix), `check:lang` (no American spellings outside the
allowlist) and `check:stubs` (no open `STUB(phase-N)` tags, and no phase
deferrals written as prose).

It does **not** check §3.4 orphan-proofing — "every exported function, store, or
component is imported and used within the live application tree" is a review
rule in the spec with no script behind it. A speculative export, or a helper
exported only so a test can reach it, will pass `verify` untouched. Check that
by hand when adding exports, and be sceptical of any sweep that reports nothing:
`grep -P` is unavailable on this repo's Git Bash, so a `-P` pattern fails
silently and reads as a clean result.

`npm run verify` enforces project invariants — notably §3.4 orphan-proofing,
which forbids store state or exported helpers that nothing in the application
tree ever calls. Run it before committing.
