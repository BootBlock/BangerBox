# Troubleshooting BangerBox

Start-up problems, and what to do about them. This is the page the in-app
"Troubleshooting guide" link points at, so it is written for whoever hit the problem —
not for developers.

If nothing here helps, please
[open an issue](https://github.com/BootBlock/BangerBox/issues/new) and include the output
of the **Copy diagnostics** button on the error screen.

---

## "BangerBox needs one more reload"

**This is normal on your first visit, and it fixes itself.**

BangerBox processes audio on a background thread, and browsers only allow that on pages
running in a special secure mode ("cross-origin isolation"). GitHub Pages cannot switch
that mode on by itself, so BangerBox installs a small service worker that does it — and a
service worker cannot change the page that installed it. Hence one extra reload.

Click **Reload the page**. You should land in the app.

### It came back after reloading

Work through these in order:

1. **Open a brand-new tab.** If it works in a fresh tab but not the old one, you hit a
   bug in versions before 2026-07-18 where a single failed attempt would keep failing for
   the rest of the browsing session. Updating to the current version fixes it for good.
2. **Disable extensions for this site, or try a private window with extensions off.** Ad
   blockers, privacy tools, and corporate web filters can strip the `Cross-Origin-Opener-Policy`
   and `Cross-Origin-Embedder-Policy` headers that the secure mode depends on. This is the
   most common cause of a _persistent_ failure.

   > Note that a private window will fix isolation but break **Private file storage**
   > (below). If the app loads in a private window, an extension is your culprit — go back
   > to a normal window and disable extensions there instead.

3. **Check you are on `https://`.** The secure mode cannot be enabled over plain `http://`
   or from a `file://` path.
4. **Clear the site's storage and reload.** In Edge/Chrome: F12 → Application →
   Storage → Clear site data. This removes a service worker that installed in a bad state.

### Running it locally

If you are serving the app yourself, the dev and preview servers set the required headers
for you:

```
npm run dev      # development
npm run preview  # production build, served locally
```

A plain static file server (`python -m http.server`, `npx serve`, opening `index.html`
directly) will **not** work — it does not send the isolation headers, and the app will
gate.

---

## "BangerBox can't start in this browser"

This screen lists each missing requirement with its own remedy. The most common ones:

### Private file storage

Where your projects, samples and recordings are saved. Blocked by:

- **Private/incognito windows.** Use a normal window.
- **Blocking site data / cookies for this site.** Allow site data for the BangerBox
  origin.
- **"Delete cookies and site data when you close all windows"** — this will also discard
  your projects when you quit, even if the app loads.

### Real-time audio processing

Your browser is too old, or audio has been disabled. Update to the current
Microsoft Edge or Google Chrome (version 120 or newer).

### WebAssembly

Every current browser supports this, so if it is missing it has usually been switched off
deliberately — by enterprise/group policy, a hardened security profile, or an extension.
If this is a work machine, check with whoever manages it.

---

## Browser support

BangerBox is built and tested on **Microsoft Edge** and **Google Chrome**, version 120 or
newer, on desktop Windows.

**Firefox** currently passes all of the app's technical requirements and will run, but it
is not tested — you may hit rough edges that nobody has looked for yet, so do not trust it
with work you cannot afford to lose. If you see a start-up error in Firefox that the steps
above do not fix, please report it.

**Safari** and mobile browsers are not supported. Tablet and desktop form factors only.

---

## Where your data lives

Everything stays on your device — projects, samples and recordings are never uploaded.
That has two consequences worth knowing:

- **Clearing site data deletes your projects.** Export anything you care about first.
- **Only one tab at a time.** The project database allows a single connection, so opening
  a second tab shows the "already open" screen rather than risking corruption. Close the
  other tab to continue.
