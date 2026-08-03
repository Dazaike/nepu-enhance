importScripts('common/store.js');

// Dev auto-reload (https://github.com/wader/crxreload-compatible). Safe no-op
// if the file is missing in a release zip. Run: python3 dev/watch.py
try {
  importScripts('dev/livereload.js');
} catch (_) {
  /* production / no livereload */
}

/**
 * NEPU_SUB_NET_FETCH: content/subtitles.js cannot reliably cross-origin
 * fetch OpenSubtitles/TMDB from a page's execution context.
 *
 * NEPU_SUB_OPEN_OPTIONS: opens full-page options screen.
 *
 * DROPBOX_SYNC: pulls/merges/pushes history, watchlist, and settings to Dropbox.
 *
 * SEND_TEST_NOTIFICATION: fires a test desktop notification.
 *
 * CHECK_RELEASES_NOW: triggers immediate TMDB new episode check for watchlist items.
 *
 * REFRESH_RECOMMENDATIONS_NOW: triggers immediate TMDB "Recommended For You" refresh.
 */

const DROPBOX_SYNC_PATH = '/nepu-watch-tracker-sync.json';
const MIN_AUTO_SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes between automatic (alarm/page) syncs
const MAX_CHANGE_SYNCS_PER_MIN = 1;
const CHANGE_SYNC_DEBOUNCE_MS = 1500;
const CHANGE_SYNC_WINDOW_MS = 60 * 1000;

// While a sync writes hist:/wl: keys back, ignore those storage events so we
// don't re-enter change-triggered sync in a loop.
let suppressChangeSyncFromStorage = false;
let changeSyncPending = false;
let changeSyncTimer = null;
/** Timestamps of change-triggered sync attempts (sliding 1‑minute window). */
const changeSyncTimes = [];

// ---------------------------------------------------------------------------
// 1. Dropbox Sync Engine
// ---------------------------------------------------------------------------

async function dropboxRefreshToken(auth) {
  const resp = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: auth.refreshToken,
      client_id: auth.appKey,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Dropbox token refresh failed (HTTP ${resp.status}) ${text}`.trim());
  }
  const body = await resp.json();
  const expiresAt = Date.now() + (body.expires_in || 14400) * 1000;
  await NVT.setDropboxAuth({ accessToken: body.access_token, expiresAt });
  return body.access_token;
}

async function getValidDropboxToken() {
  const auth = await NVT.getDropboxAuth();
  if (!auth.refreshToken || !auth.appKey) {
    throw new Error('Dropbox is not connected. Set it up on the extension options page.');
  }
  const oneMinute = 60 * 1000;
  if (auth.accessToken && auth.expiresAt && Date.now() < auth.expiresAt - oneMinute) {
    return auth.accessToken;
  }
  return dropboxRefreshToken(auth);
}

async function dropboxDownload(token) {
  const resp = await fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Dropbox-API-Arg': JSON.stringify({ path: DROPBOX_SYNC_PATH }),
    },
  });
  if (resp.status === 409) return null; // no sync file uploaded yet
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Dropbox download failed (HTTP ${resp.status}) ${text}`.trim());
  }
  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error('Dropbox sync file is corrupt (not valid JSON).');
  }
}

async function dropboxUpload(token, data) {
  const resp = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Dropbox-API-Arg': JSON.stringify({ path: DROPBOX_SYNC_PATH, mode: 'overwrite' }),
      'Content-Type': 'application/octet-stream',
    },
    body: JSON.stringify(data),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Dropbox upload failed (HTTP ${resp.status}) ${text}`.trim());
  }
}

function getItemTs(item) {
  if (!item) return 0;
  return item.updatedAt || item.addedAt || 0;
}

/** Keeps whichever copy of each record (by id) has the newer timestamp. */
function mergeById(localList, remoteList) {
  const map = new Map();
  for (const item of remoteList || []) {
    if (item && item.id) map.set(item.id, item);
  }
  for (const item of localList || []) {
    if (!item || !item.id) continue;
    const existing = map.get(item.id);
    if (!existing || getItemTs(item) >= getItemTs(existing)) {
      map.set(item.id, item);
    }
  }
  return Array.from(map.values());
}

async function isDropboxConnected() {
  const auth = await NVT.getDropboxAuth();
  return !!(auth && auth.refreshToken && auth.appKey);
}

/**
 * Periodic Dropbox sync alarm (every 5 minutes when auto-sync is on and
 * Dropbox is connected). Page-open triggers still work; this is the real
 * timer — previously only Nepu page loads kicked sync, so idle browsers
 * never synced.
 */
async function setupDropboxSyncAlarm() {
  try {
    await chrome.alarms.clear('dropboxSync');
    const settings = await NVT.getSettings();
    if (settings.dropboxAutoSync === false) return { ok: true, enabled: false };
    if (!(await isDropboxConnected())) return { ok: true, enabled: false, reason: 'not_connected' };
    // First fire soon so a fresh connect / browser start doesn't wait a full period.
    chrome.alarms.create('dropboxSync', { delayInMinutes: 0.5, periodInMinutes: 5 });
    return { ok: true, enabled: true };
  } catch (err) {
    console.warn('[Nepu background] dropbox alarm setup failed:', err);
    return { ok: false, error: String((err && err.message) || err) };
  }
}

function pruneChangeSyncTimes(now = Date.now()) {
  while (changeSyncTimes.length && now - changeSyncTimes[0] >= CHANGE_SYNC_WINDOW_MS) {
    changeSyncTimes.shift();
  }
}

/** ms until we may start another change-triggered sync (0 = free slot). */
function msUntilChangeSyncSlot(now = Date.now()) {
  pruneChangeSyncTimes(now);
  if (changeSyncTimes.length < MAX_CHANGE_SYNCS_PER_MIN) return 0;
  return Math.max(0, CHANGE_SYNC_WINDOW_MS - (now - changeSyncTimes[0]) + 25);
}

/**
 * After CW progress / Watchlist mutations: debounced sync, at most once per
 * minute. Bypasses the 5‑minute alarm throttle so devices stay closer in sync.
 */
function scheduleChangeTriggeredSync() {
  changeSyncPending = true;
  if (changeSyncTimer) clearTimeout(changeSyncTimer);
  const wait = Math.max(CHANGE_SYNC_DEBOUNCE_MS, msUntilChangeSyncSlot());
  changeSyncTimer = setTimeout(() => {
    changeSyncTimer = null;
    runChangeTriggeredSync().catch((err) => {
      console.warn('[Nepu background] change-triggered sync failed:', err);
    });
  }, wait);
}

async function runChangeTriggeredSync() {
  if (!changeSyncPending) return;
  const settings = await NVT.getSettings();
  if (settings.dropboxSyncOnChange === false) {
    changeSyncPending = false;
    return;
  }
  if (!(await isDropboxConnected())) {
    changeSyncPending = false;
    return;
  }

  const wait = msUntilChangeSyncSlot();
  if (wait > 0) {
    scheduleChangeTriggeredSync();
    return;
  }

  changeSyncPending = false;
  changeSyncTimes.push(Date.now());
  // force:true bypasses 5‑min auto throttle; still shares in-flight guard.
  const res = await performDropboxSync(true, { reason: 'change' });
  // More hist/wl writes may have arrived during the upload.
  if (changeSyncPending) scheduleChangeTriggeredSync();
  return res;
}

/**
 * @param {boolean} force - bypass 5‑min auto throttle (manual / change sync)
 * @param {{ reason?: string }} [opts]
 */
async function performDropboxSync(force, opts) {
  const reason = (opts && opts.reason) || (force ? 'manual' : 'auto');
  const now = Date.now();
  const settings = await NVT.getSettings();

  // Change-triggered path has its own rate limit; alarm/page still respect dropboxAutoSync.
  if (!force && reason !== 'change' && settings.dropboxAutoSync === false) {
    return { ok: true, skipped: true, reason: 'disabled' };
  }

  if (!(await isDropboxConnected())) {
    if (!force) return { ok: true, skipped: true, reason: 'not_connected' };
  }

  const status = await NVT.getSyncStatus();
  // Avoid stacking runs if a previous sync is still in flight (or SW died
  // mid-run — allow retry after 2 minutes of "syncing").
  if (status.syncing) {
    const started = Number(status.syncingStartedAt) || 0;
    if (started && now - started < 2 * 60 * 1000) {
      if (reason === 'change') {
        changeSyncPending = true;
        // Retry after the in-flight run should have finished.
        if (!changeSyncTimer) {
          changeSyncTimer = setTimeout(() => {
            changeSyncTimer = null;
            runChangeTriggeredSync().catch(() => {});
          }, 5000);
        }
      }
      return { ok: true, skipped: true, reason: 'in_progress', lastSyncAt: status.lastSyncAt };
    }
  }
  if (!force && status.lastSyncAt && now - status.lastSyncAt < MIN_AUTO_SYNC_INTERVAL_MS) {
    return { ok: true, skipped: true, reason: 'throttled', lastSyncAt: status.lastSyncAt };
  }

  await NVT.setSyncStatus({ syncing: true, syncingStartedAt: now });
  suppressChangeSyncFromStorage = true;
  try {
    const token = await getValidDropboxToken();
    const remote = await dropboxDownload(token);

    const [localHistory, localWatchlist, localSettings] = await Promise.all([
      NVT.listHistory(true),
      NVT.listWatchlist(true),
      NVT.getSettings(),
    ]);

    const mergedHistory = mergeById(localHistory, remote && remote.history);
    const mergedWatchlist = mergeById(localWatchlist, remote && remote.watchlist);

    let mergedSettings = localSettings;
    if (remote && remote.settings && (remote.settings.updatedAt || 0) > (localSettings.updatedAt || 0)) {
      mergedSettings = { ...localSettings, ...remote.settings };
    }

    await Promise.all([
      ...mergedHistory.map((h) => NVT.putHistoryRaw(h)),
      ...mergedWatchlist.map((w) => NVT.putWatchlistRaw(w)),
      mergedSettings !== localSettings ? chrome.storage.local.set({ settings: mergedSettings }) : Promise.resolve(),
    ]);

    await dropboxUpload(token, {
      history: mergedHistory,
      watchlist: mergedWatchlist,
      settings: mergedSettings,
      syncedAt: now,
    });

    await NVT.setSyncStatus({
      syncing: false,
      syncingStartedAt: 0,
      lastSyncAt: now,
      lastSyncOk: true,
      lastSyncError: '',
    });
    return { ok: true, lastSyncAt: now, reason };
  } catch (err) {
    const message = String((err && err.message) || err);
    await NVT.setSyncStatus({
      syncing: false,
      syncingStartedAt: 0,
      lastSyncOk: false,
      lastSyncError: message,
    });
    return { ok: false, error: message, reason };
  } finally {
    // Brief hold so storage.onChanged from our own writes drains first.
    setTimeout(() => {
      suppressChangeSyncFromStorage = false;
    }, 250);
  }
}

// Watch Continue Watching + Watchlist mutations and push soon (rate-limited).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || suppressChangeSyncFromStorage) return;
  const keys = Object.keys(changes || {});
  if (!keys.some((k) => k.startsWith(NVT.HIST_PREFIX) || k.startsWith(NVT.WL_PREFIX))) return;
  scheduleChangeTriggeredSync();
});

// ---------------------------------------------------------------------------
// 2. New Release Tracking & Desktop Notifications
// ---------------------------------------------------------------------------

async function tmdbFetch(path, query, apiKey) {
  const params = new URLSearchParams(query || {});
  params.set('api_key', apiKey);
  const resp = await fetch(`https://api.themoviedb.org/3${path}?${params.toString()}`);
  if (!resp.ok) return null;
  return resp.json().catch(() => null);
}

/** Local calendar date YYYY-MM-DD (not UTC — avoids off-by-one near midnight). */
function localTodayString() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function seBefore(season, episode) {
  const s = Number(season);
  const e = Number(episode);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return null;
  if (e > 1) return { season: s, episode: e - 1 };
  if (s > 1) return { season: s - 1, episode: null }; // unknown last ep of prior season
  return null;
}

/**
 * Resolve the last episode that has actually aired (air_date <= today).
 * A scheduled next_episode_to_air with a future air date always wins as the
 * boundary: last available = episode before that next (so "Caught up" works
 * when the user finished everything out now and the next one is e.g. Wednesday).
 */
function resolveLastAiredEpisode(series, today) {
  if (!series) return null;
  const last = series.last_episode_to_air;
  const next = series.next_episode_to_air;

  const nextS = next && next.season_number != null ? Number(next.season_number) : NaN;
  const nextE = next && next.episode_number != null ? Number(next.episode_number) : NaN;
  const nextAir = (next && next.air_date) || '';
  const nextIsFuture =
    Number.isFinite(nextS) &&
    Number.isFinite(nextE) &&
    (!!nextAir ? nextAir > today : true); // no date + listed as next → treat as not out yet

  // If TMDB advertises a not-yet-out next ep, never treat that ep (or anything
  // at/after it) as "latest aired".
  if (nextIsFuture && nextE > 1) {
    const before = seBefore(nextS, nextE);
    if (before && before.episode != null) {
      // Prefer last_episode_to_air when it is clearly earlier and already aired.
      if (last && last.season_number != null && last.episode_number != null) {
        const ls = Number(last.season_number);
        const le = Number(last.episode_number);
        const lastAir = last.air_date || '';
        const lastAired = lastAir && lastAir <= today;
        const lastBeforeNext =
          ls < nextS || (ls === nextS && le < nextE);
        if (lastAired && lastBeforeNext) {
          return {
            season: ls,
            episode: le,
            airDate: lastAir,
            title: last.name || '',
          };
        }
      }
      return {
        season: before.season,
        episode: before.episode,
        airDate: '',
        title: '',
      };
    }
  }

  if (last && last.season_number != null && last.episode_number != null) {
    const airDate = last.air_date || '';
    // Require a real past/today air date — empty date is not proof it aired
    // (TMDB sometimes stubs the next ep as last without a solid date).
    if (airDate && airDate <= today) {
      // Still clamp if next is future and last >= next (bad TMDB data).
      if (nextIsFuture && Number.isFinite(nextS) && Number.isFinite(nextE)) {
        const ls = Number(last.season_number);
        const le = Number(last.episode_number);
        if (ls > nextS || (ls === nextS && le >= nextE)) {
          const before = seBefore(nextS, nextE);
          if (before && before.episode != null) {
            return { season: before.season, episode: before.episode, airDate: '', title: '' };
          }
        }
      }
      return {
        season: Number(last.season_number),
        episode: Number(last.episode_number),
        airDate,
        title: last.name || '',
      };
    }
    // Future-dated last_episode_to_air: step back one in-season.
    if (airDate && airDate > today) {
      const before = seBefore(last.season_number, last.episode_number);
      if (before && before.episode != null) {
        return { season: before.season, episode: before.episode, airDate: '', title: '' };
      }
    }
  }

  return null;
}

async function checkNewReleases(force) {
  try {
    const settings = await NVT.getSettings();
    if (!force && !settings.releaseTrackingEnabled) {
      return { ok: true, skipped: true };
    }

    const subAuth = await NVT.getSubtitleAuth();
    const apiKey = subAuth.tmdbApiKey;
    if (!apiKey) {
      const msg = 'TMDB API key missing. Add a free TMDB key on the options page to enable release tracking.';
      await NVT.setReleaseStatus({ checking: false, lastCheckAt: Date.now(), lastCheckOk: false, lastCheckError: msg });
      return { ok: false, error: msg };
    }

    await NVT.setReleaseStatus({ checking: true });

    const watchlist = await NVT.listWatchlist();
    const optOuts = new Set(settings.releaseOptOutIds || []);
    const tvItems = watchlist.filter((item) => item && item.mediaType === 'tv' && !optOuts.has(item.id));

    let newReleasesFound = 0;
    const today = localTodayString();

    for (const item of tvItems) {
      try {
        let seriesId = item.tmdbId;

        if (!seriesId && item.imdbId) {
          const findData = await tmdbFetch(`/find/${item.imdbId}`, { external_source: 'imdb_id' }, apiKey);
          if (findData && findData.tv_results && findData.tv_results[0]) {
            seriesId = findData.tv_results[0].id;
          }
        }

        if (!seriesId && item.title) {
          const cleanQ = item.title.replace(/\b[Ss]\d+\s*[Ee]\d+\b/g, '').replace(/\b(19|20)\d{2}\b/g, '').trim();
          const searchData = await tmdbFetch('/search/tv', { query: cleanQ }, apiKey);
          if (searchData && searchData.results && searchData.results[0]) {
            seriesId = searchData.results[0].id;
          }
        }

        if (!seriesId) continue;

        const series = await tmdbFetch(`/tv/${seriesId}`, {}, apiKey);
        if (!series) continue;

        // Only count episodes that have actually aired (air_date <= today).
        // TMDB sometimes lists a not-yet-out ep as last_episode_to_air; if so,
        // fall back to the episode before next_episode_to_air / last − 1.
        const aired = resolveLastAiredEpisode(series, today);
        if (!aired) continue;

        const s = aired.season;
        const e = aired.episode;
        const airDate = aired.airDate || '';

        // Upcoming (not yet out) — for display only, never triggers NEW/notify.
        const nextEp = series.next_episode_to_air;
        const nextSeason =
          nextEp && nextEp.season_number != null ? Number(nextEp.season_number) : null;
        const nextEpisode =
          nextEp && nextEp.episode_number != null ? Number(nextEp.episode_number) : null;
        const nextAirDate = (nextEp && nextEp.air_date) || '';

        const curSeason = item.season != null ? Number(item.season) : 0;
        const curEpisode = item.episode != null ? Number(item.episode) : 0;

        const isNewer = s > curSeason || (s === curSeason && e > curEpisode);
        const hadNewReleaseBefore = !!item.hasNewRelease;

        // Previous known last-aired (before this write).
        const prevLatS = item.latestSeason != null ? Number(item.latestSeason) : NaN;
        const prevLatE = item.latestEpisode != null ? Number(item.latestEpisode) : NaN;
        // User is on/past the previous latest → they were caught up with what we knew.
        const wasCaughtUp =
          Number.isFinite(prevLatS) &&
          Number.isFinite(prevLatE) &&
          (curSeason > prevLatS || (curSeason === prevLatS && curEpisode >= prevLatE));

        // NEW badge + notifications only when the user was already caught up and
        // something newer has aired. Mid-season (e.g. on E7 while E13 is out) is
        // not "new episode" — they already have more to watch without a badge.
        // Re-check while still on that bookmark keeps NEW until they advance/clear.
        // Stale NEW from older logic clears when wasCaughtUp is false.
        const hasNewRelease = isNewer && wasCaughtUp;

        const updated = {
          ...item,
          tmdbId: seriesId,
          hasNewRelease,
          latestSeason: s,
          latestEpisode: e,
          latestAirDate: airDate,
          latestTitle: aired.title || '',
          nextSeason: Number.isFinite(nextSeason) ? nextSeason : null,
          nextEpisode: Number.isFinite(nextEpisode) ? nextEpisode : null,
          nextAirDate: nextAirDate || '',
          seriesStatus: series.status || '',
          lastReleaseCheckAt: Date.now(),
        };
        await NVT.putWatchlistRaw(updated);

        if (
          hasNewRelease &&
          !hadNewReleaseBefore &&
          settings.desktopNotificationsEnabled
        ) {
          newReleasesFound++;
          try {
            chrome.notifications.create('nepu-rel-' + item.id, {
              type: 'basic',
              iconUrl: 'icons/icon128.png',
              title: `New Episode: ${item.title}`,
              message: `Season ${s}, Episode ${e} (${aired.title || 'Latest'}) is out now! Click to open.`,
              priority: 2,
            });
          } catch (notifErr) {
            console.warn('[Nepu background] notification create failed:', notifErr);
          }
        }
      } catch (itemErr) {
        console.warn('[Nepu background] release check failed for item:', item.title, itemErr);
      }
    }

    const checkTime = Date.now();
    await NVT.setReleaseStatus({
      checking: false,
      lastCheckAt: checkTime,
      lastCheckOk: true,
      lastCheckError: '',
      newReleasesFound,
    });
    return { ok: true, lastCheckAt: checkTime, newReleasesFound };
  } catch (err) {
    const msg = String((err && err.message) || err);
    await NVT.setReleaseStatus({ checking: false, lastCheckOk: false, lastCheckError: msg });
    return { ok: false, error: msg };
  }
}

async function setupReleaseAlarm() {
  try {
    const settings = await NVT.getSettings();
    await chrome.alarms.clear('checkNewReleases');
    if (settings.releaseTrackingEnabled) {
      const hours = settings.releaseCheckIntervalHours || 12;
      chrome.alarms.create('checkNewReleases', { periodInMinutes: hours * 60 });
    }
  } catch (err) {
    console.warn('[Nepu background] alarm setup failed:', err);
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === 'checkNewReleases') {
    checkNewReleases(false);
  }
  if (alarm && alarm.name === 'refreshRecommendations') {
    fetchRecommendations(false);
  }
  if (alarm && alarm.name === 'dropboxSync') {
    performDropboxSync(false).catch((err) => {
      console.warn('[Nepu background] scheduled dropbox sync failed:', err);
    });
  }
});

chrome.notifications.onClicked.addListener(async (notifId) => {
  if (!notifId) return;
  if (notifId.startsWith('nepu-rel-')) {
    const itemId = notifId.replace('nepu-rel-', '');
    const watchlist = await NVT.listWatchlist();
    const item = watchlist.find((w) => w.id === itemId);
    if (item && item.url) {
      chrome.tabs.create({ url: item.url });
    }
  }
});

/** chrome.alarms.create({ periodInMinutes }) schedules its FIRST fire a
 * full period from now, not immediately - without this, a fresh install
 * (or first time the feature is enabled) would show an empty rail for up
 * to a full day before the alarm ever runs once. */
async function maybeInitialRecommendationsFetch() {
  try {
    const rec = await NVT.getRecommendations();
    // First install, or upgrade from the old single-rail cache shape.
    const needsRails = !rec.updatedAt || !Array.isArray(rec.rails) || !rec.rails.length;
    if (needsRails) fetchRecommendations(false);
  } catch (err) {
    console.warn('[Nepu background] initial recommendations fetch check failed:', err);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  setupReleaseAlarm();
  setupRecommendationsAlarm();
  setupDropboxSyncAlarm();
  maybeInitialRecommendationsFetch();
});

chrome.runtime.onStartup.addListener(() => {
  setupReleaseAlarm();
  setupRecommendationsAlarm();
  setupDropboxSyncAlarm();
  maybeInitialRecommendationsFetch();
});

// ---------------------------------------------------------------------------
// 3. Discovery + Recommendations rails (multi-row homepage)
// ---------------------------------------------------------------------------
// Multi-rail discovery powered by TMDB (same API we already use): Now Playing,
// Trending Movies/TV, Popular TV, Anime, genres, plus a personalized
// "Because you watched …" row when we can seed it from Continue Watching /
// Watchlist.
//
// background.js refreshes a rails cache on an alarm; content/home-rails.js
// does a fast local read (Continue Watching + Watchlist first, then these
// discovery rails). Cards open nepu search for the title (TMDB IDs ≠ nepu IDs).

const DISCOVERY_RAIL_DEFS = [
  { id: 'now-playing', title: 'Now Playing', path: '/movie/now_playing', mediaType: 'movie' },
  { id: 'trending-movies', title: 'Trending Movies', path: '/trending/movie/week', mediaType: 'movie' },
  { id: 'trending-tv', title: 'Trending TV', path: '/trending/tv/week', mediaType: 'tv' },
  { id: 'popular-tv', title: 'Popular TV Shows', path: '/tv/popular', mediaType: 'tv' },
  {
    id: 'anime',
    title: 'Anime Spotlight',
    path: '/discover/tv',
    mediaType: 'tv',
    query: { with_genres: '16', with_original_language: 'ja', sort_by: 'popularity.desc' },
  },
  {
    id: 'action',
    title: 'Action Movies',
    path: '/discover/movie',
    mediaType: 'movie',
    query: { with_genres: '28', sort_by: 'popularity.desc' },
  },
  {
    id: 'comedy',
    title: 'Comedy Movies',
    path: '/discover/movie',
    mediaType: 'movie',
    query: { with_genres: '35', sort_by: 'popularity.desc' },
  },
  {
    id: 'horror',
    title: 'Scary Movies',
    path: '/discover/movie',
    mediaType: 'movie',
    query: { with_genres: '27', sort_by: 'popularity.desc' },
  },
  {
    id: 'korean',
    title: 'Korean Movies',
    path: '/discover/movie',
    mediaType: 'movie',
    query: { with_original_language: 'ko', sort_by: 'popularity.desc' },
  },
  {
    id: 'romance',
    title: 'Romance Movies',
    path: '/discover/movie',
    mediaType: 'movie',
    query: { with_genres: '10749', sort_by: 'popularity.desc' },
  },
];

const RAIL_ITEM_LIMIT = 14;

function cleanTitleForTmdbSearch(title) {
  return String(title || '')
    .replace(/\b[Ss]\d+\s*[Ee]\d+\b/g, '')
    .replace(/\((?:19|20)\d{2}\)/g, '')
    .replace(/\b(19|20)\d{2}\b/g, '')
    .trim();
}

async function resolveTmdbSeed(item, apiKey) {
  const mediaType = item.mediaType === 'tv' ? 'tv' : 'movie';
  if (item.tmdbId) return { id: item.tmdbId, mediaType };
  const query = cleanTitleForTmdbSearch(item.title);
  if (!query) return null;
  const data = await tmdbFetch(`/search/${mediaType}`, { query }, apiKey);
  const first = data && data.results && data.results[0];
  return first ? { id: first.id, mediaType } : null;
}

function mapTmdbRecommendation(raw, fallbackMediaType) {
  if (!raw || !raw.poster_path) return null;
  const mediaType = raw.media_type || fallbackMediaType || 'movie';
  if (mediaType !== 'movie' && mediaType !== 'tv') return null;
  const dateStr = raw.release_date || raw.first_air_date || '';
  const year = dateStr ? parseInt(dateStr.slice(0, 4), 10) : null;
  return {
    id: `${mediaType}-${raw.id}`,
    tmdbId: raw.id,
    title: raw.title || raw.name || 'Untitled',
    poster: `https://image.tmdb.org/t/p/w342${raw.poster_path}`,
    mediaType,
    rating: typeof raw.vote_average === 'number' ? Math.round(raw.vote_average * 10) / 10 : null,
    year: year && year > 1900 ? year : null,
  };
}

async function fetchTmdbList(path, query, mediaType, apiKey, excludeIds) {
  const data = await tmdbFetch(path, query || {}, apiKey);
  const results = (data && data.results) || [];
  const out = [];
  for (const r of results) {
    const mapped = mapTmdbRecommendation(r, mediaType || r.media_type);
    if (!mapped) continue;
    if (excludeIds && excludeIds.has(mapped.id)) continue;
    out.push(mapped);
    if (out.length >= RAIL_ITEM_LIMIT) break;
  }
  return out;
}

async function fetchPersonalizedRail(watchlist, history, apiKey, excludeIds) {
  const seedCandidates = [
    ...NVT.sortWatchlist(watchlist.slice()),
    ...history.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
  ].filter((item) => item && item.title);

  for (const seed of seedCandidates.slice(0, 8)) {
    try {
      const resolved = await resolveTmdbSeed(seed, apiKey);
      if (!resolved) continue;
      const items = await fetchTmdbList(
        `/${resolved.mediaType}/${resolved.id}/recommendations`,
        {},
        resolved.mediaType,
        apiKey,
        excludeIds
      );
      if (items.length) {
        return {
          id: 'because-you',
          title: `Because you watched ${seed.title}`,
          items,
        };
      }
    } catch (seedErr) {
      console.warn('[Nepu background] recommendation seed failed:', seed.title, seedErr);
    }
  }
  return null;
}

async function fetchRecommendations(force) {
  try {
    const settings = await NVT.getSettings();
    if (!force && !settings.recommendationsEnabled) {
      return { ok: true, skipped: true };
    }

    const subAuth = await NVT.getSubtitleAuth();
    const apiKey = subAuth.tmdbApiKey;
    if (!apiKey) {
      const msg = 'TMDB API key missing. Add a free TMDB key on the options page to enable recommendations.';
      await NVT.setRecommendations({ checking: false, lastError: msg });
      return { ok: false, error: msg };
    }

    await NVT.setRecommendations({ checking: true });

    const [watchlist, history] = await Promise.all([NVT.listWatchlist(), NVT.listHistory()]);

    // Prefer not to re-surface titles already on the user's rails.
    const excludeIds = new Set();
    for (const item of [...watchlist, ...history]) {
      if (!item) continue;
      if (item.tmdbId) {
        const mt = item.mediaType === 'tv' ? 'tv' : 'movie';
        excludeIds.add(`${mt}-${item.tmdbId}`);
      }
    }

    const rails = [];

    const personal = await fetchPersonalizedRail(watchlist, history, apiKey, excludeIds);
    if (personal) {
      rails.push(personal);
      for (const it of personal.items) excludeIds.add(it.id);
    }

    // Discovery rows — fetch in parallel (one burst per refresh).
    const discoveryResults = await Promise.all(
      DISCOVERY_RAIL_DEFS.map(async (def) => {
        try {
          const items = await fetchTmdbList(def.path, def.query || {}, def.mediaType, apiKey, excludeIds);
          return items.length ? { id: def.id, title: def.title, items } : null;
        } catch (err) {
          console.warn('[Nepu background] discovery rail failed:', def.id, err);
          return null;
        }
      })
    );
    for (const rail of discoveryResults) {
      if (rail) rails.push(rail);
    }

    // Back-compat single-rail fields (options UI + older code paths).
    const primary = rails[0] || { title: 'Trending Now', items: [] };
    const itemCount = rails.reduce((n, r) => n + (r.items ? r.items.length : 0), 0);

    await NVT.setRecommendations({
      checking: false,
      items: primary.items || [],
      reason: primary.title || 'Recommended For You',
      rails,
      updatedAt: Date.now(),
      lastError: '',
    });
    return { ok: true, count: itemCount, rails: rails.length };
  } catch (err) {
    const msg = String((err && err.message) || err);
    await NVT.setRecommendations({ checking: false, lastError: msg });
    return { ok: false, error: msg };
  }
}

async function setupRecommendationsAlarm() {
  try {
    const settings = await NVT.getSettings();
    await chrome.alarms.clear('refreshRecommendations');
    if (settings.recommendationsEnabled) {
      const hours = settings.recommendationsCheckIntervalHours || 24;
      chrome.alarms.create('refreshRecommendations', { periodInMinutes: hours * 60 });
    }
  } catch (err) {
    console.warn('[Nepu background] recommendations alarm setup failed:', err);
  }
}

// ---------------------------------------------------------------------------
// 4. Message Routing
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'NEPU_SUB_OPEN_OPTIONS') {
    chrome.runtime.openOptionsPage();
    return false;
  }

  if (msg && msg.type === 'DROPBOX_SYNC') {
    performDropboxSync(!!(msg.payload && msg.payload.force))
      .then(async (res) => {
        // Keep the 5‑minute alarm in sync with connect / disconnect / settings.
        await setupDropboxSyncAlarm();
        sendResponse(res);
      })
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true; // async response
  }

  if (msg && msg.type === 'UPDATE_DROPBOX_ALARM') {
    setupDropboxSyncAlarm()
      .then((res) => sendResponse(res || { ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }

  if (msg && msg.type === 'SEND_TEST_NOTIFICATION') {
    try {
      chrome.notifications.create(
        'nepu-test-' + Date.now(),
        {
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: 'Nepu Watch Tracker — Test Notification',
          message: 'Desktop notifications are working! You will be alerted when new episodes of Watchlist shows air.',
          priority: 2,
        },
        () => sendResponse({ ok: true })
      );
    } catch (err) {
      sendResponse({ ok: false, error: String((err && err.message) || err) });
    }
    return true;
  }

  if (msg && msg.type === 'CHECK_RELEASES_NOW') {
    checkNewReleases(true).then(sendResponse);
    return true;
  }

  if (msg && msg.type === 'UPDATE_RELEASE_ALARM') {
    setupReleaseAlarm().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg && msg.type === 'REFRESH_RECOMMENDATIONS_NOW') {
    fetchRecommendations(true).then(sendResponse);
    return true;
  }

  if (msg && msg.type === 'UPDATE_RECOMMENDATIONS_ALARM') {
    setupRecommendationsAlarm().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (!msg || msg.type !== 'NEPU_SUB_NET_FETCH') return false;

  const { method = 'GET', url, headers = {}, body } = msg.request || {};
  fetch(url, { method, headers, body })
    .then(async (resp) => {
      const responseText = await resp.text();
      sendResponse({ ok: true, status: resp.status, responseText });
    })
    .catch((err) => {
      sendResponse({ ok: false, error: String((err && err.message) || err) });
    });
  return true; // keep the message channel open for the async response
});
