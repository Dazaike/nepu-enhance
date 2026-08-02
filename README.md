# Nepu Watch Tracker & Subtitles

Chrome **Manifest V3** extension for [Nepu](https://nepu.to/) and its mirrors
(`nepu.is`, `nepu.net`).

**Current version: 5.7.9**

## Highlights

- **Continue Watching** — track `<video>` progress and resume where you left off
- **Watchlist** — bookmark titles from the page or popup; TV entries follow the episode you’re on
- **Homepage rails** — Continue Watching + Watchlist injected above Nepu’s own rows
- **Discovery rails** — multi-row TMDB catalog (personalized + Now Playing, Trending, genres, anime)
- **Subtitles** — OpenSubtitles search/download/style, optional TMDB matching, auto-apply
- **Dropbox sync** — backup/merge CW, Watchlist, and settings (API keys stay local)
- **New episode alerts** — TMDB air-date checks + desktop notifications + **clear NEW** control
- **Modern UI** — dark theme, raised poster hover, smaller hero, pinned search + floating results

## Install (unpacked)

1. Clone or download this repository (or grab a [release](https://github.com/Dazaike/nepu-watch-tracker/releases)).
2. Open `chrome://extensions`, enable **Developer mode**.
3. Click **Load unpacked** and select the repository folder.
4. Visit `nepu.to`, `nepu.is`, or `nepu.net`.
5. (Optional) Open **Options** and add free OpenSubtitles / TMDB keys for subtitles, release tracking, and discovery rails.

## Features in detail

### Continue Watching

Any `<video>` longer than the configured minimum length is tracked. Progress
saves on pause, end, tab hide, and every few seconds while playing. Reopen the
popup or revisit the page to resume — episode-aware, so the next episode of a
show updates the same entry instead of duplicating it.

On the homepage **Continue Watching** rail, hover a poster and click **×** to
remove that entry (same as remove in the popup).

### Watchlist

Use the on-page bookmark control or **+ Add tab** in the popup. TV bookmarks
advance to the episode you’re watching; movies stay as a single entry.

### Homepage rails

Injected above Nepu’s first “Latest …” section on the homepage only:

1. **Continue Watching** (local history) — open title, or **×** to remove  
2. **Watchlist** (local list) — open title; click green **NEW** to mark caught up  
3. **Discovery rails** (TMDB cache, optional) — multi-row browse  

### Discovery rails (TMDB)

Multi-row discovery (toggle on the options page), for example:

- Personalized **Because you watched …** (when a seed is available)
- **Now Playing**, **Trending Movies**, **Trending TV**, **Popular TV Shows**
- **Anime Spotlight** and genre rows (Action, Comedy, Scary, Korean, Romance)

Cards try to **open the best Nepu catalog match** (search/ajax resolve + short
local cache). If no match is found, they fall back to Nepu search.

Refreshed on a timer (6–48 hours) or via **Refresh discovery rails now** on the
options page. Requires a free [TMDB API key](https://www.themoviedb.org/settings/api).

### Subtitles

Search OpenSubtitles by title, IMDb/TMDB ID, or season/episode; optional TMDB
lookup when the title is ambiguous. Live style controls (position, size, color,
font, background, timing). **Auto-apply** can load the first match when nothing
is loaded yet.

Needs a free [OpenSubtitles API key](https://www.opensubtitles.com/consumers)
(and optionally TMDB). Keys are set on the options page and never synced to
Dropbox.

### Dropbox sync

Backs up Continue Watching, Watchlist, and settings to a JSON file in your
Dropbox **app folder** (newest wins on merge).

1. Create a free Dropbox app at
   [dropbox.com/developers/apps](https://www.dropbox.com/developers/apps)
   (scoped access, App folder, `files.content.read` / `files.content.write`).
2. Register the redirect URI shown on the options page.
3. Paste the **App key** and click **Connect to Dropbox**.

Sync runs when you open a Nepu page (throttled) or via **Sync now** in the
popup. Auto-apply and API keys stay local.

### New release tracking & notifications

Background TMDB checks for Watchlist TV shows:

- Configurable interval (6 / 12 / 24 hours)
- Green **NEW Sx Ey** badge in the popup and on the homepage Watchlist rail
- Desktop notifications when a new episode first appears
- **Clear NEW / mark caught up:**
  - Popup list view → green **✓**
  - Popup grid view → click the **NEW** badge
  - Homepage rail → click the **NEW** badge  
  Sets progress to the latest known episode and clears `hasNewRelease`
- Per-show opt-out on the options page
- **Send test notification** on the options page

### Modern UI overhaul

Optional theme class on Nepu pages:

- Dark glass header, full-width layout, blue accent retint
- Poster cards: raised hover, soft darken (not the site’s heavy black wash)
- Full HD quality tags hidden on posters; star rating pinned inside the card
- Smaller hero carousel
- Search bar pinned top-left; typeahead results floated above the hero so they
  aren’t clipped
- Ad placeholder cleanup

Toggle: **Modern Netflix UI on Nepu** (options / popup settings).

## Settings (summary)

| Setting | Effect |
|---|---|
| Track video playback | Master on/off for Continue Watching |
| Auto-resume playback position | Seek to last position on load |
| Auto-apply captions on Nepu | Auto-search + load when none loaded |
| Show time instead of percentage | `12:34 / 45:00` vs `28%` |
| Minimum video length to track | Ignore short clips |
| Mark watched at % | Drop from CW when progress is high enough |
| Auto-sync with Dropbox | Sync on Nepu page open |
| Track new episode releases | TMDB background checks |
| Desktop notifications | OS alerts for new episodes |
| Show discovery rails on homepage | Multi-row TMDB rails |
| Modern Netflix UI on Nepu | Theme overhaul |

## Permissions

- `storage` — history, watchlist, settings (local only by default)
- `scripting`, `activeTab`, `tabs` — add current tab / site helpers
- Hosts for OpenSubtitles + TMDB — subtitle + discovery + release checks
- `identity` + Dropbox hosts — only if you connect Dropbox
- `notifications`, `alarms` — release alerts and periodic refreshes

## Project layout

```
manifest.json
background.js           Service worker: API relay, release checks, discovery cache
common/
  store.js              chrome.storage.local schema + helpers
  nepu-title.js         Nepu URL/title parsing
content/
  tracker.js            Continue Watching + auto-resume
  subtitles.js          Captions + on-page bookmark
  home-rails.js         Homepage CW / Watchlist / discovery rails
  theme.js              Theme class + search bar / typeahead chrome
  theme.css             Modern UI stylesheet
popup/                  Continue Watching, Watchlist, Subtitles, Settings
options/                Full settings + API keys + Dropbox
icons/
```

## Releases

See [GitHub Releases](https://github.com/Dazaike/nepu-watch-tracker/releases)
for tagged versions and downloadable source archives.

### Changelog (recent)

#### 5.7.8

- Homepage Continue Watching rail: **×** remove button (hover on poster)

#### 5.7.7

- Multi-rail TMDB discovery (personalized + Now Playing / Trending / genres / anime)
- Smart open for discovery cards (resolve Nepu URL, cache, search fallback)
- Clear NEW / mark caught up (popup + Watchlist rail)
- Card hover raise + custom darken; hide Full HD; pin rating badge
- Smaller hero; pinned search bar; floating typeahead over carousel

#### 5.7.0–5.7.5

- Recommended For You engine and hover-shadow / rail layout fixes

#### 5.6.x

- Hero carousel styling; player experiments reverted

## Privacy notes

- Data stays in the browser unless you use OpenSubtitles/TMDB (calls you
  trigger or background jobs you enable) or connect Dropbox.
- OpenSubtitles / TMDB keys are **not** uploaded to Dropbox.
- Cross-origin player iframes cannot receive injected captions (browser limit).
