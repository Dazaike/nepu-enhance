# Nepu Enhance

Chrome **Manifest V3** extension for [Nepu](https://nepu.to/) and its mirrors
(`nepu.is`, `nepu.net`).

**Current version: 6.4.6**

## Highlights

- **Continue Watching** — track `<video>` progress and resume where you left off
- **Watchlist** — bookmark titles from the page or popup; TV entries follow the episode you’re on
- **Homepage rails** — Continue Watching + Watchlist injected above Nepu’s own rows
- **Discovery rails** — multi-row TMDB catalog (personalized + Now Playing, Trending, genres, anime)
- **Subtitles** — OpenSubtitles search/download/style, optional TMDB matching, auto-apply
- **Dropbox sync** — backup/merge CW, Watchlist, and settings across devices
- **Local import / export** — JSON backup of history, watchlist, settings, API keys, and Dropbox OAuth (optional passphrase lock)
- **New episode alerts** — TMDB air-date checks + desktop notifications + **clear NEW** control
- **Modern UI** — Netflix-style overhaul with **mobile / tablet layout**, raised poster hover, smaller hero, pinned search + floating results

## Install (unpacked)

1. Clone or download this repository (or grab a [release](https://github.com/Dazaike/nepu-enhance/releases)).
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

Finished episodes **stay** in Continue Watching (full progress bar, no “show
finished” badge) until you remove them manually. They never auto-drop when an
episode or movie ends. Finishing still **auto-advances the Watchlist** when the
bookmark was on that S/E.

On the homepage **Continue Watching** rail, hover a poster and click **×** to
remove that entry (same as remove in the popup).

### Watchlist

Use the on-page bookmark control or **+ Add tab** in the popup. TV bookmarks
advance to the episode you’re watching; movies stay as a single entry.

When Continue Watching marks an episode **finished** (at the “Mark watched
at %” threshold) and that show is bookmarked on the **same** season/episode,
the Watchlist entry automatically moves to the **next** episode (same season,
episode + 1), but **not past** the last aired episode TMDB knows about.
Open from Watchlist uses the updated episode URL when possible.

**Watchlist status** (after a release check):
- **Caught up** — on last *aired* ep, but a later ep is still scheduled
- **Finished** — on last aired ep and nothing further is scheduled (or series ended)
- **NEW** — only if you were already caught up and a newer ep has aired (not mid-season)
Desktop notifications use the same “was caught up” rule.

**Reorder:** drag the grip handle (⋮⋮) on each Watchlist item (list and grid);
order is saved and used on the homepage rail too.

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

Auto-sync runs **every 5 minutes** in the background when Dropbox is connected
(and auto-sync is on), plus when you open a Nepu page (throttled to at most
once per 5 minutes), or anytime via **Sync now** in the popup / options.

Optional **Sync on changes**: when Continue Watching progress or the Watchlist
updates, a sync is scheduled shortly after (debounced), at most **once per
minute**, so devices stay close without spamming Dropbox.

### Local import / export

On the **Options** page, **Import & export** downloads or restores a JSON backup:

- Settings, OpenSubtitles / TMDB API keys, and Dropbox OAuth (always)
- Continue Watching + Watchlist only if you enable **Include Continue Watching & Watchlist**
  (off by default, so backups don’t overwrite progress by accident)

Optional **passphrase**: AES-GCM-encrypts Dropbox tokens and API keys (PBKDF2).
Leave blank for plaintext secrets — treat the file like a password. Import can
**merge** (newest wins) or **replace** local data when watch data is included.
Dropbox cloud sync files are also accepted when you opt into watch data.

### New release tracking & notifications

Background TMDB checks for Watchlist TV shows:

- Configurable interval (6 / 12 / 24 hours)
- Green **NEW Sx Ey** only if you were **already caught up** and something newer aired
- Desktop notifications use the same rule (no NEW spam mid-season)
- **Caught up** when you’re on the last aired ep and more may still come
- **Finished** when you’re on the last aired ep and nothing is left / series ended
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
| Mark watched at % | Treat as finished (Watchlist advance; no auto-resume at end) |
| Auto-sync with Dropbox | Background every 5 min + on Nepu page open |
| Sync on CW / Watchlist changes | Push soon after local edits (max 1× / min) |
| Track new episode releases | TMDB background checks |
| Desktop notifications | OS alerts for new episodes |
| Show discovery rails on homepage | Master on/off for homepage discovery rails |
| Discovery source / mode | Choose **TMDB API**, **Native Nepu Catalog** (instant), or **Both** |
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

See [GitHub Releases](https://github.com/Dazaike/nepu-enhance/releases)
for tagged versions and downloadable source archives.

### Changelog (recent)
#### 6.4.6

- Discovery speed optimizations: parallel TMDB resolution & instant direct search navigation from recommendation cards
- Catalog mode toggles: choose between TMDB smart discovery, native Nepu catalog rails, or both
- Automatic category tab activation on `/search/<query>#series` and `/search/<query>#movies`

#### 6.4.5

- Modern UI overhaul: high-specificity container resets, responsive side gutters, and full-bleed layout stabilization across breakpoints
- Extension rebranding and compatibility unification to Nepu Enhance
- Subtitle and caption selectors compatibility updates

#### 6.4.4

- Continue Watching: finished episodes **stay** until removed (full bar / 100%, no “show finished” badge)
- Watchlist still **auto-advances** when an episode finishes
- Watchlist status: **Caught up** (more scheduled) vs **Finished** (nothing left / series ended)
- Soft **Caught up** when you’re on the last available ep and the next airs later (e.g. Wednesday)
- **NEW** badge + desktop notifications only if you were already caught up (not mid-season)
- Watchlist reorder: **drag handle** (⋮⋮) instead of ▲/▼
- Import/export: Continue Watching + Watchlist **opt-in** (off by default)
- Fix popup subtitle timing/style helpers (`__omp_shell` ReferenceError broke Search)

#### 6.4.3

- Watchlist Complete / release-check latest S/E storage
- Finish-advance no longer bumps past last known aired episode
- Dropbox auto-sync: 5‑minute background alarm; re-sync on tab focus; sync-on-change (1×/min)
- Watchlist reorder (arrow controls; replaced by drag in 6.4.4)

#### 6.0.1

- Finish an episode in Continue Watching → if Watchlist is on that same S/E, auto-advance bookmark to the next episode

#### 6.0.0

- **Local import / export** on Options: full JSON backup (history, watchlist, settings, API keys, Dropbox OAuth)
- Optional **passphrase lock** for Dropbox tokens + API keys (AES-GCM / PBKDF2)
- **Modern UI mobile & tablet layout**: responsive gutters, search pin, hero, typeahead, denser rails
- Touch-friendly rails (always-visible remove ×) and soft poster chrome on `(hover: none)`
- Fix popup **Modern Netflix UI** toggle (listeners were nested under Auto-apply captions)
- Clear pinned search inline styles when modern UI is turned off

#### 5.7.9

- Continue Watching tracking fix: re-qualify videos when duration arrives late
- Scan shadow roots + same-origin iframe players (`all_frames`)
- Stable history keys (pathname only); theme/rails stay top-frame only

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
- OpenSubtitles / TMDB keys are **not** uploaded to Dropbox cloud sync.
- Local **Export backup** can include API keys and Dropbox OAuth tokens (optionally
  passphrase-encrypted). Keep that file private.
- Cross-origin player iframes cannot receive injected captions (browser limit).
