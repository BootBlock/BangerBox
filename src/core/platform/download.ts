/**
 * Hand a file to the user (spec §9.5 bounce, §9.6 export, §8.1 Safe-Mode rescue).
 *
 * This is the ONLY way anything BangerBox writes leaves the browser. Every other store the
 * app has — OPFS (§9.1), the SQLite VFS (§9.2) — is origin-private: no file manager can see
 * it and no part of the UI can browse `/bounces/`, so a render that only writes an OPFS file
 * has produced nothing the user can reach (issue #104). A path in a toast is not a way out;
 * a download is.
 *
 * It lived as a private copy in `BrowserPanel` and a second, bytes-taking copy in
 * `AppErrorFallback`, which is how the Song and stem bounces came to have none at all.
 */

/** Hand `blob` to the browser's downloader under `filename`. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    // Appended before the click: a detached anchor's activation is ignored by some engines,
    // and the element is removed again before this function returns either way.
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * A project name reduced to something safe to put in a download filename.
 *
 * A project name is free text, and a slash or a colon in it either breaks the save dialog or
 * is silently rewritten by the OS — so the callers that build `<project>-song.wav` all need
 * the same reduction, and got it slightly differently.
 */
export function downloadFileStem(projectName: string, fallback = 'project'): string {
  const cleaned = projectName
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '');
  return cleaned || fallback;
}
