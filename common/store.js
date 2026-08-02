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

  const DEFAULT_SETTINGS = Object.freeze({
    trackingEnabled: true,
    resumeEnabled: true,
    minDurationSeconds: 30,
    minProgressToTrack: 0.02,
    completedThreshold: 0.92,
    autoApplyCaptions: false,
    useTimeProgress: false,
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
    const next = { ...cur, ...patch };
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
    };
    await chrome.storage.local.set({ [key]: merged });
    return merged;
  }

  async function getHistoryFor(host, path) {
    const key = HIST_PREFIX + idFor(host, path);
    const res = await chrome.storage.local.get(key);
    return res[key] || null;
  }

  async function removeHistory(id) {
    await chrome.storage.local.remove(HIST_PREFIX + id);
  }

  async function listHistory() {
    const all = await chrome.storage.local.get(null);
    return Object.keys(all)
      .filter((k) => k.startsWith(HIST_PREFIX))
      .map((k) => all[k])
      .filter(Boolean);
  }

  async function clearHistory() {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith(HIST_PREFIX));
    if (keys.length) await chrome.storage.local.remove(keys);
  }

  async function addWatchlist(item) {
    const id = idFor(item.host, item.path);
    const key = WL_PREFIX + id;
    const entry = { ...item, id, addedAt: Date.now() };
    await chrome.storage.local.set({ [key]: entry });
    return entry;
  }

  async function removeWatchlist(id) {
    await chrome.storage.local.remove(WL_PREFIX + id);
  }

  async function listWatchlist() {
    const all = await chrome.storage.local.get(null);
    return Object.keys(all)
      .filter((k) => k.startsWith(WL_PREFIX))
      .map((k) => all[k])
      .filter(Boolean);
  }

  async function getWatchlistFor(host, path) {
    const key = WL_PREFIX + idFor(host, path);
    const res = await chrome.storage.local.get(key);
    return res[key] || null;
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

  return {
    HIST_PREFIX,
    WL_PREFIX,
    SUB_AUTH_KEYS,
    DEFAULT_SETTINGS,
    idFor,
    getSettings,
    setSettings,
    upsertHistory,
    getHistoryFor,
    removeHistory,
    listHistory,
    clearHistory,
    addWatchlist,
    removeWatchlist,
    listWatchlist,
    isInWatchlist,
    getWatchlistFor,
    getSubtitleAuth,
    setSubtitleAuth,
  };

})();

// Service workers use importScripts() and have no `window`; content
// scripts / extension pages get a `window`. Export defensively either way.
if (typeof self !== 'undefined') self.NVT = NVT;
