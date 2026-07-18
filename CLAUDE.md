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
| Repo invariants | `npm run verify` (deps, language, stub checks) |
| Browser smoke   | `npm run test:e2e` (hardcodes port 5199)       |

`npm run verify` enforces project invariants — notably §3.4 orphan-proofing,
which forbids store state or exported helpers that nothing in the application
tree ever calls. Run it before committing.
