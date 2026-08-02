/**
 * Shared storage layer for history (Continue Watching) and Watchlist.
 * Loaded as a classic (non-module) script by content scripts, the popup,
 * and the options page so every surface shares one schema.
 *
 * chrome.storage.local keys:
 *   "hist:<host><pathname+search>"  -> HistoryEntry
 *   "wl:<host><pathname+search>"    -> WatchlistEntry
 *   "settings"                      -> Settings
 *
 * Per-item keys (instead of one big array) avoid read-modify-write races
 * between multiple tabs updating progress concurrently.
 */
const NVT = (() => {
  const HIST_PREFIX = 'hist:';
  const WL_PREFIX = 'wl:';
  const SETTINGS_KEY = 'settings';
  const SUB_AUTH_KEYS = ['sub:osApiKey', 'sub:tmdbApiKey'];
  const DROPBOX_AUTH_KEYS = [
    'dropbox:appKey',
    'dropbox:accessToken',
    'dropbox:refreshToken',
    'dropbox:expiresAt',
    'dropbox:accountEmail',
  ];
  const SYNC_STATUS_KEY = 'dropboxSyncStatus';
  const RELEASE_STATUS_KEY = 'releaseCheckStatus';
  const RECOMMENDATIONS_KEY = 'nvtRecommendations';

  const DEFAULT_SETTINGS = Object.freeze({
    trackingEnabled: true,
    resumeEnabled: true,
    minDurationSeconds: 30,
    minProgressToTrack: 0.02,
    completedThreshold: 0.92,
    autoApplyCaptions: false,
    useTimeProgress: false,
    dropboxAutoSync: true,
    releaseTrackingEnabled: true,
    desktopNotificationsEnabled: true,
    releaseCheckIntervalHours: 12,
    releaseOptOutIds: [],
    nepuModernUi: true,
    recommendationsEnabled: true,
    recommendationsCheckIntervalHours: 24,
    updatedAt: 0,
  });

  // Nepu episode pages look like "/show/<slug>/season/<n>/episode/<n>" — a
  // history/watchlist entry keyed on the full path would fork into a new
  // entry per episode. Normalize to the show-level path ("/show/<slug>")
  // so watching (or bookmarking) the next episode updates the SAME entry
  // instead of leaving a stale duplicate behind. Non-episode paths (movies,
  // any other site) pass through unchanged.
  function normalizeEpisodePath(path) {
    const p = path || '/';
    const m = p.match(/^(\/(?:show|tv)\/[^/]+)\/season\/\d+\/episode\/\d+\/?/i);
    return m ? m[1] : p;
  }

  function idFor(host, path) {
    return `${host || ''}${normalizeEpisodePath(path)}`;
  }

  async function getSettings() {
    const res = await chrome.storage.local.get(SETTINGS_KEY);
    return { ...DEFAULT_SETTINGS, ...(res[SETTINGS_KEY] || {}) };
  }

  async function setSettings(patch) {
    const cur = await getSettings();
    const next = { ...cur, ...patch, updatedAt: Date.now() };
    await chrome.storage.local.set({ [SETTINGS_KEY]: next });
    return next;
  }

  async function upsertHistory(partial) {
    const id = idFor(partial.host, partial.path);
    const key = HIST_PREFIX + id;
    const existing = (await chrome.storage.local.get(key))[key] || null;
    const merged = {
      ...(existing || {}),
      ...partial,
      id,
      updatedAt: Date.now(),
      deleted: false,
    };
    await chrome.storage.local.set({ [key]: merged });
    return merged;
  }

  /**
   * Writes an entry exactly as given — no auto-`updatedAt` stamp. Used by
   * the Dropbox sync merge (background.js), which must preserve whichever
   * side's timestamp actually won the merge instead of always bumping it
   * to "now" on every write-through.
   */
  async function putHistoryRaw(entry) {
    if (!entry || !entry.id) return null;
    await chrome.storage.local.set({ [HIST_PREFIX + entry.id]: entry });
    return entry;
  }

  async function getHistoryFor(host, path) {
    const key = HIST_PREFIX + idFor(host, path);
    const res = await chrome.storage.local.get(key);
    const item = res[key] || null;
    return item && !item.deleted ? item : null;
  }

  async function removeHistory(id) {
    const key = HIST_PREFIX + id;
    const existing = (await chrome.storage.local.get(key))[key] || null;
    const tombstone = {
      ...(existing || {}),
      id,
      deleted: true,
      updatedAt: Date.now(),
    };
    await chrome.storage.local.set({ [key]: tombstone });
  }

  async function listHistory(includeDeleted = false) {
    const all = await chrome.storage.local.get(null);
    return Object.keys(all)
      .filter((k) => k.startsWith(HIST_PREFIX))
      .map((k) => all[k])
      .filter((item) => item && (includeDeleted || !item.deleted));
  }

  async function clearHistory() {
    const all = await chrome.storage.local.get(null);
    const now = Date.now();
    const map = {};
    for (const k of Object.keys(all)) {
      if (k.startsWith(HIST_PREFIX)) {
        const item = all[k];
        if (item && !item.deleted) {
          map[k] = { ...item, deleted: true, updatedAt: now };
        }
      }
    }
    if (Object.keys(map).length) await chrome.storage.local.set(map);
  }

  async function addWatchlist(item) {
    const id = idFor(item.host, item.path);
    const key = WL_PREFIX + id;
    const now = Date.now();
    const existing = (await chrome.storage.local.get(key))[key] || null;
    const entry = {
      ...(existing || {}),
      ...item,
      id,
      addedAt: (existing && existing.addedAt) || now,
      updatedAt: now,
      deleted: false,
    };
    await chrome.storage.local.set({ [key]: entry });
    return entry;
  }

  /** Same rationale as putHistoryRaw — no auto-`addedAt` stamp. */
  async function putWatchlistRaw(entry) {
    if (!entry || !entry.id) return null;
    await chrome.storage.local.set({ [WL_PREFIX + entry.id]: entry });
    return entry;
  }

  async function removeWatchlist(id) {
    const key = WL_PREFIX + id;
    const existing = (await chrome.storage.local.get(key))[key] || null;
    const tombstone = {
      ...(existing || {}),
      id,
      deleted: true,
      updatedAt: Date.now(),
    };
    await chrome.storage.local.set({ [key]: tombstone });
  }

  async function clearWatchlist() {
    const all = await chrome.storage.local.get(null);
    const now = Date.now();
    const map = {};
    for (const k of Object.keys(all)) {
      if (k.startsWith(WL_PREFIX)) {
        const item = all[k];
        if (item && !item.deleted) {
          map[k] = { ...item, deleted: true, updatedAt: now };
        }
      }
    }
    if (Object.keys(map).length) await chrome.storage.local.set(map);
  }

  async function listWatchlist(includeDeleted = false) {
    const all = await chrome.storage.local.get(null);
    const items = Object.keys(all)
      .filter((k) => k.startsWith(WL_PREFIX))
      .map((k) => all[k])
      .filter((item) => item && (includeDeleted || !item.deleted));

    for (const item of items) {
      if (item && item.mediaType !== 'tv' && (/\/(?:show|tv)\//i.test(item.path || '') || /\/(?:show|tv)\//i.test(item.url || ''))) {
        item.mediaType = 'tv';
      }
    }
    return items;
  }

  async function getWatchlistFor(host, path) {
    const key = WL_PREFIX + idFor(host, path);
    const res = await chrome.storage.local.get(key);
    const item = res[key] || null;
    return item && !item.deleted ? item : null;
  }

  async function isInWatchlist(host, path) {
    return !!(await getWatchlistFor(host, path));
  }

  /**
   * OpenSubtitles/TMDB API key + login state for the Nepu subtitle picker
   * (content/subtitles.js). Lives here — not per-origin page storage — so
   * one key/login works across nepu.to/.is/.net, and so the extension's
   * options page can manage it directly via chrome.storage.local.
   */
  async function getSubtitleAuth() {
    const res = await chrome.storage.local.get(SUB_AUTH_KEYS);
    return {
      osApiKey: res['sub:osApiKey'] || '',
      tmdbApiKey: res['sub:tmdbApiKey'] || '',
    };
  }

  async function setSubtitleAuth(patch) {
    const map = {};
    if (patch.osApiKey !== undefined) map['sub:osApiKey'] = patch.osApiKey;
    if (patch.tmdbApiKey !== undefined) map['sub:tmdbApiKey'] = patch.tmdbApiKey;
    await chrome.storage.local.set(map);
    return getSubtitleAuth();
  }

  /**
   * Dropbox OAuth state (PKCE, no client secret). The App Key is entered
   * once on the options page; access/refresh tokens come from the OAuth
   * exchange there and are refreshed by background.js as needed.
   */
  async function getDropboxAuth() {
    const res = await chrome.storage.local.get(DROPBOX_AUTH_KEYS);
    return {
      appKey: res['dropbox:appKey'] || '',
      accessToken: res['dropbox:accessToken'] || '',
      refreshToken: res['dropbox:refreshToken'] || '',
      expiresAt: res['dropbox:expiresAt'] || 0,
      accountEmail: res['dropbox:accountEmail'] || '',
    };
  }

  async function setDropboxAuth(patch) {
    const map = {};
    if (patch.appKey !== undefined) map['dropbox:appKey'] = patch.appKey;
    if (patch.accessToken !== undefined) map['dropbox:accessToken'] = patch.accessToken;
    if (patch.refreshToken !== undefined) map['dropbox:refreshToken'] = patch.refreshToken;
    if (patch.expiresAt !== undefined) map['dropbox:expiresAt'] = patch.expiresAt;
    if (patch.accountEmail !== undefined) map['dropbox:accountEmail'] = patch.accountEmail;
    await chrome.storage.local.set(map);
    return getDropboxAuth();
  }

  async function clearDropboxAuth() {
    await chrome.storage.local.remove(DROPBOX_AUTH_KEYS);
  }

  /** Small status blob the popup/options status bar reads directly. */
  async function getSyncStatus() {
    const res = await chrome.storage.local.get(SYNC_STATUS_KEY);
    return {
      syncing: false,
      lastSyncAt: 0,
      lastSyncOk: null,
      lastSyncError: '',
      ...(res[SYNC_STATUS_KEY] || {}),
    };
  }

  async function setSyncStatus(patch) {
    const cur = await getSyncStatus();
    const next = { ...cur, ...patch };
    await chrome.storage.local.set({ [SYNC_STATUS_KEY]: next });
    return next;
  }

  async function getReleaseStatus() {
    const res = await chrome.storage.local.get(RELEASE_STATUS_KEY);
    return {
      checking: false,
      lastCheckAt: 0,
      lastCheckOk: null,
      lastCheckError: '',
      newReleasesFound: 0,
      ...(res[RELEASE_STATUS_KEY] || {}),
    };
  }

  async function setReleaseStatus(patch) {
    const cur = await getReleaseStatus();
    const next = { ...cur, ...patch };
    await chrome.storage.local.set({ [RELEASE_STATUS_KEY]: next });
    return next;
  }

  /** TMDB-powered "Recommended For You" cache — refreshed periodically by
   * background.js (mirrors the release-tracking status pattern) so the
   * homepage rail render stays a fast local read, never a network call. */
  async function getRecommendations() {
    const res = await chrome.storage.local.get(RECOMMENDATIONS_KEY);
    return {
      items: [],
      updatedAt: 0,
      reason: '',
      checking: false,
      lastError: '',
      ...(res[RECOMMENDATIONS_KEY] || {}),
    };
  }

  async function setRecommendations(patch) {
    const cur = await getRecommendations();
    const next = { ...cur, ...patch };
    await chrome.storage.local.set({ [RECOMMENDATIONS_KEY]: next });
    return next;
  }
  return {
    HIST_PREFIX,
    WL_PREFIX,
    SUB_AUTH_KEYS,
    DROPBOX_AUTH_KEYS,
    SYNC_STATUS_KEY,
    RELEASE_STATUS_KEY,
    RECOMMENDATIONS_KEY,
    DEFAULT_SETTINGS,
    idFor,
    getSettings,
    setSettings,
    upsertHistory,
    putHistoryRaw,
    getHistoryFor,
    removeHistory,
    listHistory,
    clearHistory,
    addWatchlist,
    putWatchlistRaw,
    removeWatchlist,
    listWatchlist,
    clearWatchlist,
    isInWatchlist,
    getWatchlistFor,
    getSubtitleAuth,
    setSubtitleAuth,
    getDropboxAuth,
    setDropboxAuth,
    clearDropboxAuth,
    getSyncStatus,
    setSyncStatus,
    getReleaseStatus,
    setReleaseStatus,
    getRecommendations,
    setRecommendations,
  };

})();

// Service workers use importScripts() and have no `window`; content
// scripts / extension pages get a `window`. Export defensively either way.
if (typeof self !== 'undefined') self.NVT = NVT;
