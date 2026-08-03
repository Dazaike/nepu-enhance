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
    /** Sync soon after CW progress / Watchlist changes (max once per minute). */
    dropboxSyncOnChange: true,
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
    let p = path || '/';
    // Drop query/hash so ?server= / #frag don't fork history keys.
    p = String(p).split('?')[0].split('#')[0] || '/';
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

  /** Lower sortOrder appears first. Legacy items without sortOrder use -addedAt (newest first). */
  function watchlistSortKey(item) {
    if (item && item.sortOrder != null && Number.isFinite(Number(item.sortOrder))) {
      return Number(item.sortOrder);
    }
    return -(item && item.addedAt ? Number(item.addedAt) : 0);
  }

  function compareWatchlistOrder(a, b) {
    const ka = watchlistSortKey(a);
    const kb = watchlistSortKey(b);
    if (ka !== kb) return ka - kb;
    return String((a && a.id) || '').localeCompare(String((b && b.id) || ''));
  }

  function sortWatchlist(items) {
    return (items || []).slice().sort(compareWatchlistOrder);
  }

  /**
   * True when TMDB latest S/E is known and the bookmark is at or past it
   * (caught up with everything that has aired — show "Complete").
   */
  function isWatchlistCaughtUp(item) {
    if (!item || item.hasNewRelease) return false;
    const latS = item.latestSeason != null ? Number(item.latestSeason) : NaN;
    const latE = item.latestEpisode != null ? Number(item.latestEpisode) : NaN;
    const curS = item.season != null ? Number(item.season) : NaN;
    const curE = item.episode != null ? Number(item.episode) : NaN;
    if (!Number.isFinite(latS) || !Number.isFinite(latE)) return false;
    if (!Number.isFinite(curS) || !Number.isFinite(curE)) return false;
    return curS > latS || (curS === latS && curE >= latE);
  }

  async function addWatchlist(item) {
    const id = idFor(item.host, item.path);
    const key = WL_PREFIX + id;
    const now = Date.now();
    const existing = (await chrome.storage.local.get(key))[key] || null;
    let sortOrder =
      item.sortOrder != null
        ? item.sortOrder
        : existing && existing.sortOrder != null
          ? existing.sortOrder
          : null;
    if (sortOrder == null) {
      const others = await listWatchlist();
      const minKey = others.reduce((m, x) => Math.min(m, watchlistSortKey(x)), 0);
      sortOrder = minKey - 1;
    }
    const entry = {
      ...(existing || {}),
      ...item,
      id,
      sortOrder,
      addedAt: (existing && existing.addedAt) || now,
      updatedAt: now,
      deleted: false,
    };
    await chrome.storage.local.set({ [key]: entry });
    return entry;
  }

  /**
   * Persist explicit order from an ordered list of ids (index = sortOrder).
   * Ids omitted from the array are appended after.
   */
  async function reorderWatchlist(orderedIds) {
    const active = sortWatchlist(await listWatchlist());
    if (!active.length) return [];
    const byId = new Map(active.map((i) => [i.id, i]));
    const seen = new Set();
    const ordered = [];
    for (const id of orderedIds || []) {
      const item = byId.get(id);
      if (item && !seen.has(id)) {
        ordered.push(item);
        seen.add(id);
      }
    }
    for (const item of active) {
      if (!seen.has(item.id)) ordered.push(item);
    }
    const map = {};
    const now = Date.now();
    ordered.forEach((item, index) => {
      map[WL_PREFIX + item.id] = { ...item, sortOrder: index, updatedAt: now };
    });
    if (Object.keys(map).length) await chrome.storage.local.set(map);
    return ordered.map((item, index) => ({ ...item, sortOrder: index, updatedAt: now }));
  }

  /** Move a watchlist item up (delta -1) or down (delta +1) in the sorted list. */
  async function moveWatchlistItem(id, delta) {
    const items = sortWatchlist(await listWatchlist());
    const idx = items.findIndex((i) => i.id === id);
    if (idx < 0) return null;
    const j = idx + Number(delta);
    if (!Number.isFinite(j) || j < 0 || j >= items.length) return items;
    const next = items.slice();
    const [row] = next.splice(idx, 1);
    next.splice(j, 0, row);
    return reorderWatchlist(next.map((i) => i.id));
  }

  /** Same rationale as putHistoryRaw — no auto-`addedAt` stamp. */
  async function putWatchlistRaw(entry) {
    if (!entry || !entry.id) return null;
    await chrome.storage.local.set({ [WL_PREFIX + entry.id]: entry });
    return entry;
  }

  /**
   * Clear the "NEW Sx Ey" badge: mark the user caught up to the latest
   * known episode (or simply drop the flag if we never stored latest S/E).
   */
  async function clearNewReleaseBadge(id) {
    if (!id) return null;
    const key = WL_PREFIX + id;
    const existing = (await chrome.storage.local.get(key))[key] || null;
    if (!existing || existing.deleted) return null;
    const latestS = existing.latestSeason != null ? Number(existing.latestSeason) : null;
    const latestE = existing.latestEpisode != null ? Number(existing.latestEpisode) : null;
    const next = {
      ...existing,
      hasNewRelease: false,
      updatedAt: Date.now(),
    };
    if (latestS != null && !Number.isNaN(latestS)) next.season = latestS;
    if (latestE != null && !Number.isNaN(latestE)) next.episode = latestE;
    await chrome.storage.local.set({ [key]: next });
    return next;
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
   * Rewrite Nepu episode segments in a stored path/url so Open from
   * Watchlist lands on the next episode after a finish advance.
   */
  function rewriteEpisodeRef(ref, season, episode) {
    if (!ref || season == null || episode == null) return ref;
    const s = Number(season);
    const e = Number(episode);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e < 1) return ref;
    const next = String(ref).replace(
      /\/season\/\d+\/episode\/\d+/i,
      `/season/${s}/episode/${e}`
    );
    return next;
  }

  /**
   * When Continue Watching marks an episode finished: if that show is on
   * the Watchlist and the bookmark still points at the finished episode,
   * advance the bookmark to the next episode (same season, episode + 1).
   * Idempotent — once advanced, later complete saves no longer match.
   * Never auto-adds; movies / missing S/E are left alone.
   */
  async function advanceWatchlistAfterEpisodeComplete(host, path, season, episode) {
    const s = season != null && season !== '' ? Number(season) : NaN;
    const e = episode != null && episode !== '' ? Number(episode) : NaN;
    if (!Number.isFinite(s) || !Number.isFinite(e) || e < 1) return null;

    const existing = await getWatchlistFor(host, path);
    if (!existing) return null;

    const curS = existing.season != null ? Number(existing.season) : NaN;
    const curE = existing.episode != null ? Number(existing.episode) : NaN;
    if (!Number.isFinite(curS) || !Number.isFinite(curE)) return null;
    if (curS !== s || curE !== e) return null;

    // Don't advance past the last known aired episode (keeps "Complete" honest).
    const latS = existing.latestSeason != null ? Number(existing.latestSeason) : NaN;
    const latE = existing.latestEpisode != null ? Number(existing.latestEpisode) : NaN;
    if (Number.isFinite(latS) && Number.isFinite(latE)) {
      if (s > latS || (s === latS && e >= latE)) return existing;
      if (s === latS && e + 1 > latE) return existing;
    }

    const nextEpisode = e + 1;
    const next = {
      ...existing,
      season: s,
      episode: nextEpisode,
      mediaType: existing.mediaType || 'tv',
      path: rewriteEpisodeRef(existing.path, s, nextEpisode) || existing.path,
      url: rewriteEpisodeRef(existing.url, s, nextEpisode) || existing.url,
      updatedAt: Date.now(),
      deleted: false,
    };
    await chrome.storage.local.set({ [WL_PREFIX + existing.id]: next });
    return next;
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

  /** TMDB-powered discovery rails cache (multi-row rows + personalized
   * "Because you watched …"). Refreshed by background.js so the homepage
   * rail render stays a fast local read, never a network call. */
  async function getRecommendations() {
    const res = await chrome.storage.local.get(RECOMMENDATIONS_KEY);
    return {
      items: [],
      rails: [],
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

  // --- Backup crypto (optional passphrase for Dropbox OAuth + API keys) ---
  const BACKUP_FORMAT = 'nepu-watch-tracker';
  const BACKUP_VERSION = 2;
  const SECRETS_PBKDF2_ITERS = 250000;

  function bytesToB64(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let binary = '';
    for (let i = 0; i < u8.length; i++) binary += String.fromCharCode(u8[i]);
    return btoa(binary);
  }

  function b64ToBytes(b64) {
    const binary = atob(String(b64 || ''));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }

  async function deriveSecretsKey(passphrase, saltBytes) {
    const material = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(String(passphrase)),
      'PBKDF2',
      false,
      ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: saltBytes,
        iterations: SECRETS_PBKDF2_ITERS,
        hash: 'SHA-256',
      },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function encryptSecretsBlob(secretsObj, passphrase) {
    if (!passphrase) throw new Error('Passphrase is required to lock secrets.');
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveSecretsKey(passphrase, salt);
    const plain = new TextEncoder().encode(JSON.stringify(secretsObj));
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
    return {
      v: 1,
      alg: 'AES-GCM',
      kdf: 'PBKDF2-SHA256',
      iterations: SECRETS_PBKDF2_ITERS,
      salt: bytesToB64(salt),
      iv: bytesToB64(iv),
      ciphertext: bytesToB64(cipher),
    };
  }

  async function decryptSecretsBlob(blob, passphrase) {
    if (!blob || !blob.ciphertext) throw new Error('Backup has no encrypted secrets.');
    if (!passphrase) throw new Error('This backup’s Dropbox / API keys are locked — enter the passphrase.');
    try {
      const salt = b64ToBytes(blob.salt);
      const iv = b64ToBytes(blob.iv);
      const key = await deriveSecretsKey(passphrase, salt);
      const plainBuf = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        key,
        b64ToBytes(blob.ciphertext)
      );
      return JSON.parse(new TextDecoder().decode(plainBuf));
    } catch (err) {
      if (err && /passphrase|locked/i.test(String(err.message))) throw err;
      throw new Error('Wrong passphrase or corrupted secrets block.');
    }
  }

  function normalizeDropboxAuthExport(auth) {
    if (!auth) return null;
    const out = {
      appKey: auth.appKey || '',
      accessToken: auth.accessToken || '',
      refreshToken: auth.refreshToken || '',
      expiresAt: auth.expiresAt || 0,
      accountEmail: auth.accountEmail || '',
    };
    // Only include if there is something useful to restore.
    if (!out.appKey && !out.refreshToken && !out.accessToken) return null;
    return out;
  }

  /**
   * Local file backup (options page Import/Export). Compatible with the
   * Dropbox sync JSON shape (history + watchlist + settings) plus subtitle
   * API keys and Dropbox OAuth (app key + refresh/access tokens).
   *
   * @param {{ passphrase?: string }} [opts]
   *   If passphrase is set, Dropbox OAuth + subtitle keys are AES-GCM encrypted
   *   into `secretsEncrypted` (PBKDF2). History/watchlist/settings stay plain
   *   so the file is still useful without unlocking secrets.
   */
  async function exportBackup(opts) {
    const passphrase = opts && opts.passphrase ? String(opts.passphrase) : '';
    const [history, watchlist, settings, subtitleAuth, dropboxAuth] = await Promise.all([
      listHistory(true),
      listWatchlist(true),
      getSettings(),
      getSubtitleAuth(),
      getDropboxAuth(),
    ]);

    const secrets = {
      subtitleAuth: {
        osApiKey: subtitleAuth.osApiKey || '',
        tmdbApiKey: subtitleAuth.tmdbApiKey || '',
      },
      dropboxAuth: normalizeDropboxAuthExport(dropboxAuth),
    };

    const base = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: Date.now(),
      history,
      watchlist,
      settings,
    };

    if (passphrase) {
      base.secretsEncrypted = await encryptSecretsBlob(secrets, passphrase);
      base.secretsLocked = true;
    } else {
      base.subtitleAuth = secrets.subtitleAuth;
      if (secrets.dropboxAuth) base.dropboxAuth = secrets.dropboxAuth;
      base.secretsLocked = false;
    }

    return base;
  }

  function itemTs(item) {
    if (!item) return 0;
    return item.updatedAt || item.addedAt || 0;
  }

  function mergeListsById(localList, remoteList) {
    const map = new Map();
    for (const item of remoteList || []) {
      if (item && item.id) map.set(item.id, item);
    }
    for (const item of localList || []) {
      if (!item || !item.id) continue;
      const existing = map.get(item.id);
      if (!existing || itemTs(item) >= itemTs(existing)) {
        map.set(item.id, item);
      }
    }
    return Array.from(map.values());
  }

  /**
   * @param {object} payload - exportBackup() JSON or Dropbox sync file
   * @param {{ mode?: 'merge' | 'replace', passphrase?: string }} [opts]
   *   merge   — newest-wins per id (default; safe for multi-device)
   *   replace — overwrite history/watchlist/settings with the file
   *   passphrase — unlock secretsEncrypted (Dropbox OAuth + API keys)
   */
  async function importBackup(payload, opts) {
    const mode = (opts && opts.mode) === 'replace' ? 'replace' : 'merge';
    const passphrase = opts && opts.passphrase ? String(opts.passphrase) : '';
    if (!payload || typeof payload !== 'object') {
      throw new Error('Invalid backup file (not a JSON object).');
    }
    if (payload.format && payload.format !== BACKUP_FORMAT) {
      throw new Error(`Unsupported backup format: ${payload.format}`);
    }
    if (payload.version != null && Number(payload.version) > BACKUP_VERSION) {
      throw new Error(`Backup version ${payload.version} is newer than this extension supports.`);
    }

    // Unlock passphrase-protected secrets (Dropbox OAuth + subtitle keys).
    let unlockedSecrets = null;
    if (payload.secretsEncrypted) {
      unlockedSecrets = await decryptSecretsBlob(payload.secretsEncrypted, passphrase);
    }

    const incomingHistory = Array.isArray(payload.history) ? payload.history : null;
    const incomingWatchlist = Array.isArray(payload.watchlist) ? payload.watchlist : null;
    const incomingSettings =
      payload.settings && typeof payload.settings === 'object' ? payload.settings : null;
    const incomingSub =
      (unlockedSecrets && unlockedSecrets.subtitleAuth) ||
      (payload.subtitleAuth && typeof payload.subtitleAuth === 'object'
        ? payload.subtitleAuth
        : null);
    const incomingDropbox =
      (unlockedSecrets && unlockedSecrets.dropboxAuth) ||
      (payload.dropboxAuth && typeof payload.dropboxAuth === 'object'
        ? payload.dropboxAuth
        : null);

    if (
      !incomingHistory &&
      !incomingWatchlist &&
      !incomingSettings &&
      !incomingSub &&
      !incomingDropbox
    ) {
      throw new Error(
        'Backup has no history, watchlist, settings, API keys, or Dropbox auth to import.'
      );
    }

    const [localHistory, localWatchlist, localSettings] = await Promise.all([
      listHistory(true),
      listWatchlist(true),
      getSettings(),
    ]);

    let nextHistory = localHistory;
    let nextWatchlist = localWatchlist;
    if (incomingHistory) {
      nextHistory =
        mode === 'replace'
          ? incomingHistory.filter((h) => h && h.id)
          : mergeListsById(localHistory, incomingHistory);
    }
    if (incomingWatchlist) {
      nextWatchlist =
        mode === 'replace'
          ? incomingWatchlist.filter((w) => w && w.id)
          : mergeListsById(localWatchlist, incomingWatchlist);
    }

    if (mode === 'replace' && (incomingHistory || incomingWatchlist)) {
      // Tombstone anything local that is not present in the replace set so
      // Dropbox-style soft-deletes and listHistory(false) stay consistent.
      const keepHist = new Set(nextHistory.map((h) => h.id));
      const keepWl = new Set(nextWatchlist.map((w) => w.id));
      const now = Date.now();
      for (const h of localHistory) {
        if (h && h.id && !keepHist.has(h.id) && !h.deleted) {
          nextHistory.push({ ...h, deleted: true, updatedAt: now });
        }
      }
      for (const w of localWatchlist) {
        if (w && w.id && !keepWl.has(w.id) && !w.deleted) {
          nextWatchlist.push({ ...w, deleted: true, updatedAt: now });
        }
      }
    }

    const writes = [];
    for (const h of nextHistory) {
      if (h && h.id) writes.push(putHistoryRaw(h));
    }
    for (const w of nextWatchlist) {
      if (w && w.id) writes.push(putWatchlistRaw(w));
    }

    let nextSettings = localSettings;
    if (incomingSettings) {
      if (mode === 'replace' || (incomingSettings.updatedAt || 0) >= (localSettings.updatedAt || 0)) {
        nextSettings = {
          ...DEFAULT_SETTINGS,
          ...localSettings,
          ...incomingSettings,
          updatedAt: Date.now(),
        };
        writes.push(chrome.storage.local.set({ [SETTINGS_KEY]: nextSettings }));
      }
    }

    if (incomingSub) {
      const patch = {};
      if (typeof incomingSub.osApiKey === 'string' && incomingSub.osApiKey) {
        patch.osApiKey = incomingSub.osApiKey;
      }
      if (typeof incomingSub.tmdbApiKey === 'string' && incomingSub.tmdbApiKey) {
        patch.tmdbApiKey = incomingSub.tmdbApiKey;
      }
      if (Object.keys(patch).length) writes.push(setSubtitleAuth(patch));
    }

    let restoredDropbox = false;
    if (incomingDropbox) {
      const dbPatch = {};
      if (typeof incomingDropbox.appKey === 'string' && incomingDropbox.appKey) {
        dbPatch.appKey = incomingDropbox.appKey;
      }
      if (typeof incomingDropbox.accessToken === 'string' && incomingDropbox.accessToken) {
        dbPatch.accessToken = incomingDropbox.accessToken;
      }
      if (typeof incomingDropbox.refreshToken === 'string' && incomingDropbox.refreshToken) {
        dbPatch.refreshToken = incomingDropbox.refreshToken;
      }
      if (incomingDropbox.expiresAt != null && incomingDropbox.expiresAt !== '') {
        dbPatch.expiresAt = Number(incomingDropbox.expiresAt) || 0;
      }
      if (typeof incomingDropbox.accountEmail === 'string') {
        dbPatch.accountEmail = incomingDropbox.accountEmail;
      }
      if (Object.keys(dbPatch).length) {
        writes.push(setDropboxAuth(dbPatch));
        restoredDropbox = !!(dbPatch.refreshToken || dbPatch.accessToken);
      }
    }

    await Promise.all(writes);

    return {
      mode,
      history: nextHistory.filter((h) => h && !h.deleted).length,
      watchlist: nextWatchlist.filter((w) => w && !w.deleted).length,
      settings: nextSettings !== localSettings,
      subtitleAuth: !!(incomingSub && (incomingSub.osApiKey || incomingSub.tmdbApiKey)),
      dropboxAuth: restoredDropbox,
      secretsUnlocked: !!unlockedSecrets,
    };
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
    clearNewReleaseBadge,
    removeWatchlist,
    listWatchlist,
    clearWatchlist,
    isInWatchlist,
    getWatchlistFor,
    advanceWatchlistAfterEpisodeComplete,
    watchlistSortKey,
    compareWatchlistOrder,
    sortWatchlist,
    isWatchlistCaughtUp,
    reorderWatchlist,
    moveWatchlistItem,
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
    exportBackup,
    importBackup,
  };

})();

// Service workers use importScripts() and have no `window`; content
// scripts / extension pages get a `window`. Export defensively either way.
if (typeof self !== 'undefined') self.NVT = NVT;
