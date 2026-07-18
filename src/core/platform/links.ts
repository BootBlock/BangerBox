/**
 * Canonical outbound links. Centralised so the repo can move without a hunt through the
 * UI, and so every help surface (capability gate, unsupported-browser notice) points at
 * the same places.
 *
 * WHY `troubleshooting` POINTS AT THE REPO AND NOT THE WIKI: a GitHub wiki serves its
 * Home page, with HTTP 200, for any page that does not exist yet. A deep link to an
 * unwritten wiki page therefore does not 404 — it silently drops the reader on an
 * unrelated page with no explanation, which is worse than a broken link because nobody
 * can tell it is broken. `docs/TROUBLESHOOTING.md` is version-controlled alongside the
 * code, so it always exists and always matches the build the user is running. Once the
 * wiki's Troubleshooting page is written, point this at `${wiki}/Troubleshooting`.
 */
export const LINKS = Object.freeze({
  repo: 'https://github.com/BootBlock/BangerBox',
  /** Wiki home — exists, and is the hub the troubleshooting guides will live under. */
  wiki: 'https://github.com/BootBlock/BangerBox/wiki',
  /** Guaranteed-live troubleshooting guide; see the note above before changing. */
  troubleshooting: 'https://github.com/BootBlock/BangerBox/blob/main/docs/TROUBLESHOOTING.md',
  issues: 'https://github.com/BootBlock/BangerBox/issues',
  newIssue: 'https://github.com/BootBlock/BangerBox/issues/new',
});
