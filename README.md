# Nepu Watch Tracker & Subtitles

A Chrome (Manifest V3) extension for [Nepu](https://nepu.to/) and its mirrors
(`nepu.is`, `nepu.net`) that adds:

- **Continue Watching** — tracks playback progress on any `<video>` you
  watch and lets you resume exactly where you left off, including inside
  same-origin embedded players.
- **Watchlist** — bookmark shows/movies from the page itself or from the
  popup; TV bookmarks automatically track whatever episode you're currently
  on.
- **On-page rails** — a "Continue Watching" / "Watchlist" row injected
  directly into the Nepu homepage, above the site's own "Latest ..." rows.
- **Subtitles** — search, download, and style OpenSubtitles captions
  (with optional TMDB-assisted matching) from a dedicated popup tab,
  including an auto-apply mode that loads the first match automatically.

## Install (unpacked)

1. Clone or download this repository.
2. Open `chrome://extensions`, enable **Developer mode**.
3. Click **Load unpacked** and select the repository folder.
4. Visit `nepu.to`, `nepu.is`, or `nepu.net` and start watching.

## Features in detail

### Continue Watching
Any `<video>` element longer than the configured minimum length is tracked.
Progress saves immediately on pause, on the video ending, when the tab is
hidden, and periodically (every 5 seconds) while playing. Reopen the popup
or revisit the page and playback resumes automatically — episode-aware, so
starting the next episode of a show updates the same bookmark instead of
creating a duplicate.

### Watchlist
Click the bookmark icon injected next to a title's own action buttons (or
use "+ Add tab" in the popup) to save it. TV show bookmarks silently track
forward to whichever episode you're currently on; movies stay as a single
entry.

### Subtitles
Search OpenSubtitles by title, IMDb ID, TMDB ID, or season/episode; narrow
results with a TMDB lookup when a plain title search is ambiguous. Caption
style (position, size, color, font, background, timing offset) is
adjustable live from the **Style** tab. An **auto-apply** setting searches
and loads the first match automatically when nothing is loaded yet.

Requires a free [OpenSubtitles API key](https://www.opensubtitles.com/consumers)
and, optionally, a [TMDB API key](https://www.themoviedb.org/settings/api)
for more reliable TV episode matching — both are entered on the extension's
options page (right-click the extension icon → **Options**), and are shared
across all three Nepu mirrors.

## Settings

Available from the popup's **Settings** tab and the full options page:

| Setting | Effect |
|---|---|
| Track video playback | Master on/off switch for Continue Watching |
| Auto-resume playback position | Seek to your last position on load |
| Auto-apply captions on Nepu | Auto-search + load subtitles when none are loaded yet |
| Show time instead of percentage | Display `12:34 / 45:00` instead of `28%` |
| Minimum video length to track | Ignore short clips/previews below this length |
| Mark watched at % | Progress threshold at which a video drops out of Continue Watching |

## Permissions

- `storage` — all watch history, watchlist entries, and settings are kept
  in `chrome.storage.local` (never leaves the browser).
- `scripting`, `activeTab`, `tabs` — used by the popup's "+ Add current tab"
  watchlist button and "Exclude this site" settings shortcut.
- Host permissions for `opensubtitles.com` and `themoviedb.org` — the
  background service worker relays subtitle search/download requests to
  these APIs, since content scripts don't get an automatic CORS bypass.

## Project layout

```
manifest.json
background.js          Service worker: OpenSubtitles/TMDB network relay
common/
  store.js             Shared chrome.storage.local schema (history, watchlist, settings)
  nepu-title.js         Nepu URL/title parsing shared by the tracker and subtitle search
content/
  tracker.js            Continue Watching tracking + auto-resume
  subtitles.js           Subtitle search/download/style engine + on-page bookmark button
  home-rails.js           Continue Watching/Watchlist rails on the Nepu homepage
popup/                  Extension popup UI (Continue Watching, Watchlist, Subtitles, Settings)
options/                Full-page settings + OpenSubtitles/TMDB API keys
icons/
```

## Notes

- All data stays local to your browser; nothing is sent anywhere except
  the OpenSubtitles/TMDB API calls you trigger yourself.
- If a Nepu page embeds its player in a cross-origin iframe, captions
  cannot be injected into that frame (a browser security limitation, not
  something this extension can work around).
