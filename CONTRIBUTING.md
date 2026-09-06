# Contributing

**BangerBox does not accept unsolicited pull requests. Any pull request opened by someone without
write access to this repository is closed automatically.**

That is not a comment on the quality of the change. BangerBox is built by a single maintainer
against one binding specification, [`docs/todo/_spec.md`](docs/todo/_spec.md), which governs the
architecture, the dependency surface, the phase protocol, and the house language. A patch written
outside that process almost always conflicts with something the specification has already settled,
and reconciling it costs more than writing the change did.

## What is welcome

Issues. If you have found a bug, hit a browser or hardware combination that misbehaves, or spotted
something the documentation gets wrong, please [open an issue](https://github.com/BootBlock/BangerBox/issues).
A clear report is worth considerably more here than a patch is.

Useful things to include:

- The browser and its version, and the operating system.
- What you did, what you expected, and what happened instead.
- Anything the browser console printed.

## If you have been asked to send a change

Someone with write access will have said so explicitly, and will have pointed you at the relevant
specification section. In that case:

- Work on a branch and keep the change to the one thing it is about.
- Run the full gate before you push: `npm run type-check`, `npm run lint`, `npm test`,
  `npm run format:check` and `npm run verify`.
- Write British English, in code and in prose. `npm run verify` enforces this.

## Forking

The [MIT Licence](LICENSE) applies, so you are free to fork BangerBox and take it wherever you
like. Doing so needs no permission and no discussion.
