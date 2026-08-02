importScripts('common/store.js');

/**
 * NEPU_SUB_NET_FETCH: content/subtitles.js cannot reliably cross-origin
 * fetch OpenSubtitles/TMDB from a page's execution context (CORS
 * preflight on custom headers like Api-Key/Authorization is not
 * guaranteed). The service worker has host_permissions for those hosts,
 * which exempts its fetches from CORS entirely.
 *
 * NEPU_SUB_OPEN_OPTIONS: content scripts can't reliably call
 * chrome.runtime.openOptionsPage() themselves, so they ask the background
 * page to do it (used when an OpenSubtitles/TMDB key is missing).
 *
 * DROPBOX_SYNC: pulls/merges/pushes Continue Watching, Watchlist, and
 * settings against a single JSON file in the user's Dropbox app folder.
 * Runs here (not in the content script that triggers it) for the same
 * CORS-bypass reason, and so token refresh never races across tabs.
 */

const DROPBOX_SYNC_PATH = '/nepu-watch-tracker-sync.json';
const MIN_AUTO_SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes between automatic syncs

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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'NEPU_SUB_OPEN_OPTIONS') {
    chrome.runtime.openOptionsPage();
    return false;
  }

  if (msg && msg.type === 'DROPBOX_SYNC') {
    performDropboxSync(!!(msg.payload && msg.payload.force)).then(sendResponse);
    return true; // async response
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
