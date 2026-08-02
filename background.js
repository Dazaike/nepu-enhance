importScripts('common/store.js');

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
const MIN_AUTO_SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes between automatic syncs

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

async function performDropboxSync(force) {
  const status = await NVT.getSyncStatus();
  const now = Date.now();
  if (!force && status.lastSyncAt && now - status.lastSyncAt < MIN_AUTO_SYNC_INTERVAL_MS) {
    return { ok: true, skipped: true, lastSyncAt: status.lastSyncAt };
  }

  await NVT.setSyncStatus({ syncing: true });
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
      lastSyncAt: now,
      lastSyncOk: true,
      lastSyncError: '',
    });
    return { ok: true, lastSyncAt: now };
  } catch (err) {
    const message = String((err && err.message) || err);
    await NVT.setSyncStatus({ syncing: false, lastSyncOk: false, lastSyncError: message });
    return { ok: false, error: message };
  }
}

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
    const today = new Date().toISOString().slice(0, 10);

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
        if (!series || !series.last_episode_to_air) continue;

        const lastEp = series.last_episode_to_air;
        const s = lastEp.season_number;
        const e = lastEp.episode_number;
        const airDate = lastEp.air_date || '';

        const curSeason = item.season != null ? Number(item.season) : 0;
        const curEpisode = item.episode != null ? Number(item.episode) : 0;

        const isNewer = s > curSeason || (s === curSeason && e > curEpisode);
        const hasAired = !!airDate && airDate <= today;

        const hadNewReleaseBefore = !!item.hasNewRelease;
        const hasNewRelease = isNewer && hasAired;

        if (hasNewRelease || hadNewRelease !== hasNewRelease) {
          const updated = {
            ...item,
            hasNewRelease,
            latestSeason: s,
            latestEpisode: e,
            latestAirDate: airDate,
            latestTitle: lastEp.name || '',
            lastReleaseCheckAt: Date.now(),
          };
          await NVT.putWatchlistRaw(updated);

          if (hasNewRelease && !hadNewReleaseBefore && settings.desktopNotificationsEnabled) {
            newReleasesFound++;
            try {
              chrome.notifications.create('nepu-rel-' + item.id, {
                type: 'basic',
                iconUrl: 'icons/icon128.png',
                title: `New Episode: ${item.title}`,
                message: `Season ${s}, Episode ${e} (${lastEp.name || 'Latest'}) is out now! Click to open.`,
                priority: 2,
              });
            } catch (notifErr) {
              console.warn('[Nepu background] notification create failed:', notifErr);
            }
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

chrome.runtime.onInstalled.addListener(() => {
  setupReleaseAlarm();
  setupRecommendationsAlarm();
});

chrome.runtime.onStartup.addListener(() => {
  setupReleaseAlarm();
  setupRecommendationsAlarm();
});

// ---------------------------------------------------------------------------
// 3. Recommendations Engine ("Recommended For You" homepage rail)
// ---------------------------------------------------------------------------
// nepu's own catalog is fine but its recommendations are weak. TMDB (the
// same API already used for release tracking and subtitle matching above)
// has a real recommendations graph. This mirrors the release-tracking
// pattern exactly: background.js refreshes a cache on an alarm, and
// content/home-rails.js just does a fast local read of that cache to
// render the rail — no network calls at page-render time.
//
// Recommendation cards have no direct nepu.is URL (TMDB IDs don't map to
// nepu's internal catalog IDs), so home-rails.js instead submits nepu's
// own live search form for the title when a card is clicked.

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
  const mediaType = raw.media_type || fallbackMediaType;
  return {
    id: `${mediaType}-${raw.id}`,
    title: raw.title || raw.name || 'Untitled',
    poster: `https://image.tmdb.org/t/p/w342${raw.poster_path}`,
    mediaType,
    rating: typeof raw.vote_average === 'number' ? Math.round(raw.vote_average * 10) / 10 : null,
  };
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
    const seedCandidates = [
      ...watchlist.slice().sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)),
      ...history.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
    ].filter((item) => item && item.title);

    let items = [];
    let reason = 'Trending Now';

    for (const seed of seedCandidates) {
      try {
        const resolved = await resolveTmdbSeed(seed, apiKey);
        if (!resolved) continue;
        const recData = await tmdbFetch(`/${resolved.mediaType}/${resolved.id}/recommendations`, {}, apiKey);
        const results = (recData && recData.results) || [];
        const mapped = results.map((r) => mapTmdbRecommendation(r, resolved.mediaType)).filter(Boolean);
        if (mapped.length) {
          items = mapped.slice(0, 12);
          reason = `Because you watched ${seed.title}`;
          break;
        }
      } catch (seedErr) {
        console.warn('[Nepu background] recommendation seed failed:', seed.title, seedErr);
      }
    }

    if (!items.length) {
      const trending = await tmdbFetch('/trending/all/week', {}, apiKey);
      const results = (trending && trending.results) || [];
      items = results
        .filter((r) => r.media_type === 'movie' || r.media_type === 'tv')
        .map((r) => mapTmdbRecommendation(r, r.media_type))
        .filter(Boolean)
        .slice(0, 12);
      reason = 'Trending Now';
    }

    await NVT.setRecommendations({
      checking: false,
      items,
      reason,
      updatedAt: Date.now(),
      lastError: '',
    });
    return { ok: true, count: items.length };
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
    performDropboxSync(!!(msg.payload && msg.payload.force)).then(sendResponse);
    return true; // async response
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
