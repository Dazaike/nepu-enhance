// Nepu Subtitle Injector — Chrome extension content script (nepu.to/.is/.net)
//
// Originally ported from a Tampermonkey userscript for Nepu subtitle
// injection, then rearchitected so the entire
// in-page shadow-DOM picker panel (Search/Style tabs, CC button) has been
// removed. All of that UI now lives in the extension popup's "Subtitles"
// tab; this content script is a headless engine that:
//   1. Runs the OpenSubtitles/TMDB search + download + VTT injection logic
//      (unchanged from the original script) in response to chrome.runtime
//      messages from the popup (see the SUB_* message handlers near the
//      bottom of this file).
//   2. Optionally auto-searches and injects the first result on its own,
//      when Settings -> "Auto-apply captions" is on and nothing is loaded
//      yet (see maybeAutoApplyCaptions()).
// Cross-origin OpenSubtitles/TMDB requests go through the background
// service worker (see gmRequest) since content scripts don't get a
// userscript manager's CORS bypass; the manifest declares host_permissions
// for those APIs on the background side instead.
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // 1. Config / storage
  // ---------------------------------------------------------------------------

  const APP_UA = 'NepuSubtitleInjector v1.0';
  const OS_API = 'https://api.opensubtitles.com/api/v1';
  const TMDB_API = 'https://api.themoviedb.org/3';
  const OVERLAY_ID = 'nepu-subtitle-overlay';
  /** localStorage fallback prefix when GM storage is unavailable */
  const LS_PREFIX = 'nepuSubtitleInjector:';

  const STORAGE = {
    // apiKey/tmdbApiKey/jwt/osUsername moved to chrome.storage.local via
    // NVT.getSubtitleAuth()/setSubtitleAuth() (see options page) so the same
    // keys/login work across nepu.to/.is/.net instead of per-origin storage.
    preferredLang: 'preferredLang',
    lastPicks: 'lastPicks',
    captionStyle: 'captionStyle',
    captionsHidden: 'captionsHidden',
    // Legacy global offset — migrated into pageSession; kept only to clear
    timingOffset: 'timingOffset',
    timingPrecise: 'timingPrecise',
    // Survives Ctrl-R/F5 for the same pathname; cleared on video/page change
    pageSession: 'pageSession',
  };

  /** Lost on script re-inject (common on mobile Tampermonkey). Prefer window/session/local/GM. */
  const memoryStore = Object.create(null);
  const WIN_STORE_KEY = '__NEPU_SUB_STORE__';

  const DEFAULT_CAPTION_STYLE = {
    // Pixels up from the bottom of the player chrome (not % of height — that breaks fullscreen)
    bottomPx: 72,
    // 0–100% horizontal within the player
    horizontal: 50,
    fontSize: 24,
    color: '#ffffff',
    fontFamily: 'Arial, Helvetica, sans-serif',
    // box | rounded | plate | soft (soft = blur halo around glyphs, no plate)
    background: 'box',
    // 0–100: plate opacity, or soft-blur hardness
    bgOpacity: 72,
    // soft blur halo radius in px
    blurRadius: 16,
    // flat | outline | shadow | raised | inset
    depth: 'outline',
  };

  function migrateCaptionStyle(raw) {
    const s = { ...DEFAULT_CAPTION_STYLE, ...(raw && typeof raw === 'object' ? raw : {}) };

    if (typeof s.horizontal === 'string') {
      s.horizontal = ({ left: 12, center: 50, right: 88 }[s.horizontal] ?? 50);
    }
    s.horizontal = Math.max(0, Math.min(100, Number(s.horizontal) || 50));

    // Migrate old vertical % → approximate bottomPx (assumes ~480px player height)
    if (s.bottomPx == null || s.bottomPx === '') {
      let vertical = s.vertical;
      if (typeof vertical === 'string') {
        vertical = ({ top: 12, middle: 50, bottom: 88 }[vertical] ?? 88);
      }
      if (vertical != null && vertical !== '') {
        const v = Math.max(0, Math.min(100, Number(vertical) || 88));
        s.bottomPx = Math.round(((100 - v) / 100) * 480);
      } else {
        s.bottomPx = DEFAULT_CAPTION_STYLE.bottomPx;
      }
    }
    s.bottomPx = Math.max(0, Math.min(400, Number(s.bottomPx) || DEFAULT_CAPTION_STYLE.bottomPx));

    s.bgOpacity = Math.max(0, Math.min(100, Number(s.bgOpacity ?? DEFAULT_CAPTION_STYLE.bgOpacity)));
    s.blurRadius = Math.max(2, Math.min(48, Number(s.blurRadius ?? DEFAULT_CAPTION_STYLE.blurRadius)));

    // Old "blur" meant rounded plate + backdrop blur
    if (s.background === 'blur') s.background = 'plate';
    if (!s.depth) s.depth = DEFAULT_CAPTION_STYLE.depth;

    // Drop legacy fields from persisted object on next save
    delete s.vertical;
    delete s.verticalFs;
    delete s.horizontalFs;
    return s;
  }

  function getCaptionStyle() {
    return migrateCaptionStyle(gmGet(STORAGE.captionStyle, null));
  }

  function saveCaptionStyle(style) {
    gmSet(STORAGE.captionStyle, migrateCaptionStyle(style));
  }

  function getCaptionsHidden() {
    return !!gmGet(STORAGE.captionsHidden, false);
  }

  function setCaptionsHidden(hidden) {
    gmSet(STORAGE.captionsHidden, !!hidden);
  }

  function readRawPageSession() {
    const raw = gmGet(STORAGE.pageSession, null);
    return raw && typeof raw === 'object' ? raw : null;
  }

  /** Session for the current pathname only (null if path changed / cleared). */
  function getPageSession() {
    const raw = readRawPageSession();
    if (!raw || raw.path !== location.pathname) return null;
    return raw;
  }

  function updatePageSession(patch) {
    const raw = readRawPageSession();
    const base =
      raw && raw.path === location.pathname
        ? raw
        : { path: location.pathname, timingOffset: 0 };
    const next = { ...base, ...patch, path: location.pathname, updatedAt: Date.now() };
    gmSet(STORAGE.pageSession, next);
    return next;
  }

  function clearPageSession() {
    gmSet(STORAGE.pageSession, null);
    // Drop legacy global timing so it can't leak onto the next video
    try {
      gmSet(STORAGE.timingOffset, 0);
    } catch (_) {
      /* ignore */
    }
  }

  function getTimingOffset() {
    const session = getPageSession();
    const n = Number(session && session.timingOffset != null ? session.timingOffset : 0);
    if (!Number.isFinite(n)) return 0;
    if (getTimingPrecise()) {
      return Math.max(-3600, Math.min(3600, n));
    }
    return Math.max(-10, Math.min(10, n));
  }

  function setTimingOffset(sec, { precise } = {}) {
    const n = Number(sec);
    const usePrecise = precise != null ? !!precise : getTimingPrecise();
    let clamped;
    if (!Number.isFinite(n)) {
      clamped = 0;
    } else if (usePrecise) {
      clamped = Math.max(-3600, Math.min(3600, n));
    } else {
      clamped = Math.max(-10, Math.min(10, n));
    }
    updatePageSession({ timingOffset: clamped });
    return clamped;
  }

  function savePageCaptions(vttText, meta, extra) {
    if (!vttText) return;
    updatePageSession({
      vtt: String(vttText),
      meta: {
        language: (meta && meta.language) || 'en',
        label: (meta && meta.label) || '',
      },
      fileId: extra && extra.fileId != null ? extra.fileId : (getPageSession() || {}).fileId,
      query: extra && extra.query != null ? extra.query : (getPageSession() || {}).query,
    });
  }

  function clearLastPickForPage(pathname) {
    const all = getLastPicks();
    const key = titleStorageKey(pathname);
    if (!all[key]) return;
    delete all[key];
    gmSet(STORAGE.lastPicks, all);
  }

  function getTimingPrecise() {
    return !!gmGet(STORAGE.timingPrecise, false);
  }

  function setTimingPrecise(on) {
    gmSet(STORAGE.timingPrecise, !!on);
  }

  function getWinStore() {
    try {
      if (!window[WIN_STORE_KEY] || typeof window[WIN_STORE_KEY] !== 'object') {
        window[WIN_STORE_KEY] = Object.create(null);
      }
      return window[WIN_STORE_KEY];
    } catch (_) {
      return null;
    }
  }

  function winGet(key, fallback) {
    const store = getWinStore();
    if (!store || !Object.prototype.hasOwnProperty.call(store, key)) return fallback;
    const v = store[key];
    return v === undefined || v === null ? fallback : v;
  }

  function winSet(key, value) {
    const store = getWinStore();
    if (!store) return false;
    store[key] = value;
    return true;
  }

  function ssGet(key, fallback) {
    try {
      const raw = sessionStorage.getItem(LS_PREFIX + key);
      if (raw == null) return fallback;
      try {
        return JSON.parse(raw);
      } catch (_) {
        return raw;
      }
    } catch (_) {
      return fallback;
    }
  }

  function ssSet(key, value) {
    try {
      sessionStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
      return true;
    } catch (_) {
      return false;
    }
  }

  function lsGet(key, fallback) {
    try {
      const raw = localStorage.getItem(LS_PREFIX + key);
      if (raw == null) return fallback;
      try {
        return JSON.parse(raw);
      } catch (_) {
        return raw;
      }
    } catch (_) {
      return fallback;
    }
  }

  function lsSet(key, value) {
    try {
      localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
      return true;
    } catch (_) {
      return false;
    }
  }

  /** Durable stores only — survives Tampermonkey re-injecting the script. */
  function durableGet(key, fallback) {
    const win = winGet(key, null);
    if (win !== null && win !== undefined) return win;
    const ss = ssGet(key, null);
    if (ss !== null && ss !== undefined) return ss;
    const ls = lsGet(key, null);
    if (ls !== null && ls !== undefined) return ls;
    try {
      if (typeof GM_getValue === 'function') {
        const v = GM_getValue(key, null);
        if (v !== undefined && v !== null) return v;
      }
    } catch (_) {
      /* ignore */
    }
    return fallback;
  }

  function gmGet(key, fallback) {
    if (Object.prototype.hasOwnProperty.call(memoryStore, key)) {
      const mem = memoryStore[key];
      if (mem !== undefined && mem !== null) return mem;
    }
    return durableGet(key, fallback);
  }

  function gmSet(key, value) {
    memoryStore[key] = value;
    let ok = false;
    if (winSet(key, value)) ok = true;
    if (ssSet(key, value)) ok = true;
    if (lsSet(key, value)) ok = true;
    try {
      if (typeof GM_setValue === 'function') {
        GM_setValue(key, value);
        ok = true;
      }
    } catch (err) {
      console.warn('[Nepu Subtitles] GM_setValue failed:', err);
    }
    try {
      if (typeof GM !== 'undefined' && typeof GM.setValue === 'function') {
        Promise.resolve(GM.setValue(key, value)).catch((err) => {
          console.warn('[Nepu Subtitles] GM.setValue failed:', err);
        });
        ok = true;
      }
    } catch (err) {
      console.warn('[Nepu Subtitles] GM.setValue failed:', err);
    }
    return ok;
  }

  async function gmSetAsync(key, value) {
    const syncOk = gmSet(key, value);
    let asyncOk = false;
    try {
      if (typeof GM !== 'undefined' && typeof GM.setValue === 'function') {
        await GM.setValue(key, value);
        asyncOk = true;
      }
    } catch (err) {
      console.warn('[Nepu Subtitles] await GM.setValue failed:', err);
    }
    return syncOk || asyncOk;
  }

  // OpenSubtitles/TMDB API key + login state now live in the extension's
  // options page (chrome.storage.local, shared across nepu.to/.is/.net)
  // instead of this per-origin panel. We keep a synchronous in-memory cache
  // refreshed on load and on chrome.storage.onChanged so the many call
  // sites below (osHeaders, tmdbKeyParam, etc.) can stay synchronous.
  const subAuthCache = { osApiKey: '', tmdbApiKey: '' };

  async function refreshSubAuthCache() {
    try {
      subAuthCache.osApiKey = '';
      subAuthCache.tmdbApiKey = '';
      const auth = await NVT.getSubtitleAuth();
      Object.assign(subAuthCache, auth);
    } catch (err) {
      console.warn('[Nepu Subtitles] failed to load API keys from extension storage:', err);
    }
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (NVT.SUB_AUTH_KEYS.some((k) => Object.prototype.hasOwnProperty.call(changes, k))) {
        refreshSubAuthCache();
      }
    });
  } catch (_) {
    /* ignore */
  }

  function getApiKey() {
    return subAuthCache.osApiKey;
  }

  function getTmdbApiKey() {
    return subAuthCache.tmdbApiKey;
  }

  function openExtensionSettings() {
    try {
      chrome.runtime.sendMessage({ type: 'NEPU_SUB_OPEN_OPTIONS' });
    } catch (_) {
      /* ignore */
    }
  }

  function getPreferredLang() {
    return String(gmGet(STORAGE.preferredLang, 'en') || 'en').trim() || 'en';
  }

  function titleStorageKey(pathname) {
    return `nepu:${pathname || location.pathname}`;
  }

  function getLastPicks() {
    const raw = gmGet(STORAGE.lastPicks, {});
    return raw && typeof raw === 'object' ? raw : {};
  }

  function getLastPickForPage() {
    return getLastPicks()[titleStorageKey()] || null;
  }

  function saveLastPick(pick) {
    const all = getLastPicks();
    all[titleStorageKey()] = {
      fileId: pick.fileId,
      language: pick.language,
      label: pick.label || '',
      query: pick.query || '',
      savedAt: Date.now(),
    };
    gmSet(STORAGE.lastPicks, all);
  }

  // ---------------------------------------------------------------------------
  // 2. Title identification
  // ---------------------------------------------------------------------------
  // Moved to common/nepu-title.js (loaded before this file — see
  // manifest.json) so content/tracker.js can reuse the same slug/JSON-LD
  // parsing for clean Continue Watching titles instead of raw document
  // titles. Exposes: identifyTitle(), formatSeTag(), metaContent().

  // ---------------------------------------------------------------------------
  // 3. OpenSubtitles client
  // ---------------------------------------------------------------------------

  function gmRequest(opts) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          type: 'NEPU_SUB_NET_FETCH',
          request: {
            method: opts.method || 'GET',
            url: opts.url,
            headers: opts.headers || {},
            body: opts.data,
          },
        },
        (res) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!res || !res.ok) {
            reject(new Error((res && res.error) || 'Network error'));
            return;
          }
          resolve({ status: res.status, responseText: res.responseText });
        }
      );
    });
  }

  function osHeaders(extra) {
    const headers = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Api-Key': getApiKey(),
      'User-Agent': APP_UA,
      ...(extra || {}),
    };
    return headers;
  }

  class OsError extends Error {
    constructor(message, code, body) {
      super(message);
      this.name = 'OsError';
      this.code = code;
      this.body = body;
    }
  }

  function parseOsBody(res) {
    let body = null;
    try {
      body = typeof res.responseText === 'string' && res.responseText
        ? JSON.parse(res.responseText)
        : null;
    } catch (_) {
      body = null;
    }
    return body;
  }

  function raiseOsHttp(res, fallbackMsg) {
    const body = parseOsBody(res);
    const msg =
      (body && (body.message || body.error || body.errors)) ||
      fallbackMsg ||
      `HTTP ${res.status}`;
    const text = Array.isArray(msg) ? msg.join('; ') : String(msg);
    if (res.status === 429) {
      throw new OsError(
        'Rate limited or out of downloads for today. Try again later, or log in to raise the free-tier cap.',
        429,
        body
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new OsError(
        'Unauthorized — check your OpenSubtitles API key in the extension Settings.',
        res.status,
        body
      );
    }
    throw new OsError(text, res.status, body);
  }

  async function osSearch({
    query,
    languages,
    imdbId,
    tmdbId,
    parentImdbId,
    parentTmdbId,
    season,
    episode,
  }) {
    if (!getApiKey()) {
      throw new OsError("OpenSubtitles API key not set. Add it in the extension's Settings page.", 0);
    }

    const seasonNum = season != null && season !== '' ? Number(season) : null;
    const episodeNum = episode != null && episode !== '' ? Number(episode) : null;
    const hasSe =
      Number.isFinite(seasonNum) &&
      Number.isFinite(episodeNum) &&
      seasonNum >= 0 &&
      episodeNum >= 0;

    const parentImdb = parentImdbId
      ? String(parentImdbId).replace(/^tt/i, '')
      : '';
    const episodeImdb = imdbId ? String(imdbId).replace(/^tt/i, '') : '';

    function buildParams({ withType }) {
      const params = new URLSearchParams();
      if (hasSe) {
        params.set('season_number', String(seasonNum));
        params.set('episode_number', String(episodeNum));
        if (withType) params.set('type', 'episode');
        if (parentImdb) params.set('parent_imdb_id', parentImdb);
        else if (parentTmdbId) params.set('parent_tmdb_id', String(parentTmdbId));
        else if (episodeImdb) params.set('imdb_id', episodeImdb);
        else if (tmdbId) params.set('tmdb_id', String(tmdbId));
        else if (query) params.set('query', query);
        else throw new OsError('Enter a title, IMDb/TMDB ID, or season/episode.', 0);
      } else if (episodeImdb) {
        params.set('imdb_id', episodeImdb);
      } else if (tmdbId) {
        params.set('tmdb_id', String(tmdbId));
      } else if (query) {
        params.set('query', query);
      } else {
        throw new OsError('Enter a title or IMDb ID to search.', 0);
      }
      if (languages) params.set('languages', languages);
      params.set('order_by', 'download_count');
      params.set('order_direction', 'desc');
      return params;
    }

    async function fetchOnce(params) {
      const res = await gmRequest({
        method: 'GET',
        url: `${OS_API}/subtitles?${params.toString()}`,
        headers: osHeaders(),
      });
      if (res.status < 200 || res.status >= 300) raiseOsHttp(res, 'Search failed');
      const body = parseOsBody(res);
      const data = (body && body.data) || [];
      return data.map(normalizeCandidate).filter(Boolean);
    }

    let results = await fetchOnce(buildParams({ withType: hasSe }));
    if (hasSe && !results.length) {
      results = await fetchOnce(buildParams({ withType: false }));
    }

    if (hasSe) {
      const matched = results.filter((c) => {
        if (c.seasonNumber == null || c.episodeNumber == null) return true;
        return Number(c.seasonNumber) === seasonNum && Number(c.episodeNumber) === episodeNum;
      });
      if (matched.length) return matched;
    }
    return results;
  }

  function normalizeCandidate(item) {
    if (!item) return null;
    const attrs = item.attributes || {};
    const files = attrs.files || [];
    const file = files[0] || {};
    const feature = attrs.feature_details || {};
    const fileId = file.file_id || file.fileId;
    if (!fileId) return null;
    return {
      id: item.id,
      fileId,
      language: attrs.language || '',
      hearingImpaired: !!(attrs.hearing_impaired || attrs.hearingImpaired),
      release: attrs.release || file.file_name || attrs.feature_details?.title || '',
      filename: file.file_name || '',
      uploader: (attrs.uploader && (attrs.uploader.name || attrs.uploader.uploader_name)) || '',
      downloadCount: attrs.download_count || attrs.times_downloaded || 0,
      fps: attrs.fps || null,
      fromTrusted: !!(attrs.from_trusted || attrs.trusted),
      movieName: feature.movie_name || feature.title || attrs.feature_details?.movie_name || '',
      year: feature.year || '',
      seasonNumber: feature.season_number != null ? Number(feature.season_number) : null,
      episodeNumber: feature.episode_number != null ? Number(feature.episode_number) : null,
      parentTitle: feature.parent_title || '',
      raw: item,
    };
  }

  async function osDownload(fileId) {
    if (!getApiKey()) {
      throw new OsError('OpenSubtitles API key not set.', 0);
    }
    const res = await gmRequest({
      method: 'POST',
      url: `${OS_API}/download`,
      headers: osHeaders(),
      data: JSON.stringify({ file_id: Number(fileId) || fileId }),
    });
    if (res.status < 200 || res.status >= 300) raiseOsHttp(res, 'Download request failed');
    const body = parseOsBody(res);
    const link = body && body.link;
    if (!link) {
      const remaining = body && body.remaining;
      if (remaining === 0) {
        throw new OsError(
          'Out of downloads for today. Log in via the panel to raise the free-tier cap, or wait until reset.',
          429,
          body
        );
      }
      throw new OsError('Download response missing link.', res.status, body);
    }

    const fileRes = await gmRequest({
      method: 'GET',
      url: link,
      headers: { 'User-Agent': APP_UA },
      responseType: 'text',
    });
    if (fileRes.status < 200 || fileRes.status >= 300) {
      throw new OsError(`Failed to fetch subtitle file (HTTP ${fileRes.status})`, fileRes.status);
    }
    return {
      content: fileRes.responseText || '',
      fileName: (body && body.file_name) || '',
      remaining: body && body.remaining,
      resetTime: body && (body.reset_time || body.reset_time_utc),
    };
  }

  // ---------------------------------------------------------------------------
  // 3b. TMDB client
  // ---------------------------------------------------------------------------

  class TmdbError extends Error {
    constructor(message, code, body) {
      super(message);
      this.name = 'TmdbError';
      this.code = code;
      this.body = body;
    }
  }

  function tmdbKeyParam() {
    const key = getTmdbApiKey();
    if (!key) throw new TmdbError("TMDB API key not set. Add it in the extension's Settings page.", 0);
    return key;
  }

  async function tmdbGet(path, query) {
    const params = new URLSearchParams(query || {});
    params.set('api_key', tmdbKeyParam());
    const res = await gmRequest({
      method: 'GET',
      url: `${TMDB_API}${path}?${params.toString()}`,
      headers: { Accept: 'application/json' },
    });
    let body = null;
    try {
      body = res.responseText ? JSON.parse(res.responseText) : null;
    } catch (_) {
      body = null;
    }
    if (res.status < 200 || res.status >= 300) {
      const msg =
        (body && (body.status_message || body.errors)) ||
        `TMDB HTTP ${res.status}`;
      throw new TmdbError(Array.isArray(msg) ? msg.join('; ') : String(msg), res.status, body);
    }
    return body;
  }

  async function tmdbSearchMulti(query) {
    const q = String(query || '').trim();
    if (!q) throw new TmdbError('Enter a title to search on TMDB.', 0);
    const body = await tmdbGet('/search/multi', { query: q, include_adult: 'false' });
    const results = (body && body.results) || [];
    return results
      .filter((r) => r && (r.media_type === 'movie' || r.media_type === 'tv'))
      .map((r) => {
        const isTv = r.media_type === 'tv';
        const title = isTv ? r.name || r.original_name : r.title || r.original_title;
        const year = String(isTv ? r.first_air_date || '' : r.release_date || '').slice(0, 4);
        return {
          id: r.id,
          mediaType: isTv ? 'tv' : 'movie',
          title: title || 'Untitled',
          year,
          overview: r.overview || '',
        };
      });
  }

  async function tmdbExternalIds(mediaType, id, season, episode) {
    if (mediaType === 'tv' && season != null && episode != null && season !== '' && episode !== '') {
      return tmdbGet(`/tv/${id}/season/${Number(season)}/episode/${Number(episode)}/external_ids`);
    }
    if (mediaType === 'tv') return tmdbGet(`/tv/${id}/external_ids`);
    return tmdbGet(`/movie/${id}/external_ids`);
  }

  async function tmdbResolvePick(item, season, episode) {
    const ids = await tmdbExternalIds(item.mediaType, item.id, season, episode);
    const imdbRaw = ids && ids.imdb_id ? String(ids.imdb_id) : '';
    const imdbId = imdbRaw.startsWith('tt') ? imdbRaw : imdbRaw ? `tt${imdbRaw}` : '';
    const isEpisode =
      item.mediaType === 'tv' &&
      season != null &&
      episode != null &&
      season !== '' &&
      episode !== '';

    let parentImdbId = '';
    let parentTmdbId = '';
    if (isEpisode) {
      parentTmdbId = String(item.id);
      try {
        const showIds = await tmdbGet(`/tv/${item.id}/external_ids`);
        const p = showIds && showIds.imdb_id ? String(showIds.imdb_id) : '';
        parentImdbId = p.startsWith('tt') ? p : p ? `tt${p}` : '';
      } catch (_) {
        /* ignore */
      }
    }

    const se = isEpisode ? formatSeTag(season, episode) : '';
    const query = se
      ? `${item.title} ${se}`.trim()
      : [item.title, item.year].filter(Boolean).join(' ').trim();

    return {
      title: item.title,
      year: item.year || '',
      query,
      imdbId: isEpisode ? '' : imdbId,
      episodeImdbId: isEpisode ? imdbId : '',
      tmdbId: isEpisode ? '' : String(item.id),
      parentImdbId,
      parentTmdbId: isEpisode ? parentTmdbId : '',
      season: isEpisode ? Number(season) : null,
      episode: isEpisode ? Number(episode) : null,
      mediaType: item.mediaType,
    };
  }

  // ---------------------------------------------------------------------------
  // 4. SRT → VTT
  // ---------------------------------------------------------------------------

  function srtToVtt(input) {
    let text = String(input || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (/^\s*WEBVTT/i.test(text)) {
      return text.trimStart().startsWith('WEBVTT') ? text : `WEBVTT\n\n${text}`;
    }

    // Strip numeric cue indexes; convert comma decimals in timestamps
    const lines = text.split('\n');
    const out = ['WEBVTT', ''];
    let i = 0;
    while (i < lines.length) {
      let line = lines[i];
      if (!line.trim()) {
        out.push('');
        i += 1;
        continue;
      }
      // Skip cue number-only lines
      if (/^\d+$/.test(line.trim()) && i + 1 < lines.length && /-->/.test(lines[i + 1])) {
        i += 1;
        line = lines[i];
      }
      if (/-->/.test(line)) {
        out.push(line.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2'));
        i += 1;
        while (i < lines.length && lines[i].trim() !== '') {
          out.push(lines[i]);
          i += 1;
        }
        out.push('');
        continue;
      }
      out.push(line);
      i += 1;
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }

  function vttBlobUrl(vttText) {
    const blob = new Blob([vttText], { type: 'text/vtt' });
    return URL.createObjectURL(blob);
  }

  function parseTimestamp(ts) {
    const cleaned = String(ts || '')
      .trim()
      .replace(',', '.')
      .replace(/[^\d:.]/g, '');
    const parts = cleaned.split(':');
    let h = 0;
    let m = 0;
    let s = 0;
    if (parts.length === 3) {
      h = parseInt(parts[0], 10) || 0;
      m = parseInt(parts[1], 10) || 0;
      s = parseFloat(parts[2]) || 0;
    } else if (parts.length === 2) {
      m = parseInt(parts[0], 10) || 0;
      s = parseFloat(parts[1]) || 0;
    } else {
      s = parseFloat(parts[0]) || 0;
    }
    return h * 3600 + m * 60 + s;
  }

  function parseVttCues(vttText) {
    const text = String(vttText || '')
      .replace(/^\uFEFF/, '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n');
    const cues = [];
    const blocks = text.split(/\n\n+/);
    for (const block of blocks) {
      const rawLines = block.split('\n').map((l) => l.trimEnd());
      const lines = rawLines.filter((l, idx) => {
        if (idx === 0 && /^\s*WEBVTT/i.test(l)) return false;
        if (idx === 0 && /^NOTE\b/i.test(l)) return false;
        if (idx === 0 && /^STYLE\b/i.test(l)) return false;
        return true;
      });
      if (!lines.length) continue;
      const timeLineIdx = lines.findIndex((l) => /-->/.test(l));
      if (timeLineIdx < 0) continue;
      const timeLine = lines[timeLineIdx].replace(/-->/g, ' --> ');
      const parts = timeLine.split(/\s*-->\s*/);
      if (parts.length < 2) continue;
      const startTok = parts[0].trim().split(/\s+/)[0];
      const endTok = parts[1].trim().split(/\s+/)[0];
      const start = parseTimestamp(startTok);
      const end = parseTimestamp(endTok);
      if (!(end > start)) continue;
      const cueText = lines
        .slice(timeLineIdx + 1)
        .join('\n')
        .replace(/<\/?[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .trim();
      if (cueText) cues.push({ start, end, text: cueText });
    }
    return cues;
  }

  // ---------------------------------------------------------------------------
  // 5. Player detect + inject
  // ---------------------------------------------------------------------------

  let activeBlobUrl = null;
  let overlayState = null;

  function trySameOriginDocs() {
    const docs = [document];
    const iframes = document.querySelectorAll('iframe');
    for (const frame of iframes) {
      try {
        const doc = frame.contentDocument || (frame.contentWindow && frame.contentWindow.document);
        if (doc) docs.push(doc);
      } catch (_) {
        /* cross-origin */
      }
    }
    return docs;
  }

  function findVideos() {
    const videos = [];
    for (const doc of trySameOriginDocs()) {
      doc.querySelectorAll('video').forEach((v) => videos.push(v));
    }
    return videos;
  }

  function detectCrossOriginPlayerOnly() {
    const localVideos = findVideos();
    if (localVideos.length) {
      return { blocked: false, videos: localVideos, iframes: [] };
    }
    const iframes = Array.from(document.querySelectorAll('iframe')).filter((f) => {
      try {
        void (f.contentDocument || f.contentWindow.document);
        return false;
      } catch (_) {
        return true;
      }
    });
    return {
      blocked: iframes.length > 0,
      videos: [],
      iframes,
      embedHints: iframes.map((f) => f.src || f.getAttribute('data-src') || '').filter(Boolean),
    };
  }

  function pickBestVideo(videos) {
    if (!videos.length) return null;
    const scored = videos.map((v) => {
      const rect = v.getBoundingClientRect();
      const area = Math.max(0, rect.width) * Math.max(0, rect.height);
      const playing = !v.paused && !v.ended ? 1e9 : 0;
      return { v, score: playing + area };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored[0].v;
  }

  function revokeActiveBlob() {
    if (activeBlobUrl) {
      try {
        URL.revokeObjectURL(activeBlobUrl);
      } catch (_) {
        /* ignore */
      }
      activeBlobUrl = null;
    }
  }

  function removeInjectedTracks(video) {
    if (!video) return;
    video.querySelectorAll('track[data-nepu-sub="1"]').forEach((t) => t.remove());
    try {
      const list = video.textTracks;
      for (let i = 0; i < list.length; i++) {
        const track = list[i];
        if (track && track.label && String(track.label).startsWith('Nepu OS:')) {
          track.mode = 'disabled';
        }
      }
    } catch (_) {
      /* ignore */
    }
  }

  function getFullscreenElement() {
    return (
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.mozFullScreenElement ||
      document.msFullscreenElement ||
      null
    );
  }

  /** Keep overlay in the visible fullscreen subtree when needed. */
  function placeOverlayHost(host) {
    if (!host) return;
    const fs = getFullscreenElement();
    let target = document.documentElement;
    if (fs && fs.tagName !== 'VIDEO') {
      target = fs;
    }
    if (host.parentNode !== target) {
      try {
        target.appendChild(host);
      } catch (_) {
        document.documentElement.appendChild(host);
      }
    }

    // Full-bleed layer — zero-size hosts can prevent children from painting.
    // Always fixed: inside a fullscreen element, fixed is relative to that element.
    Object.assign(host.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      right: '0',
      bottom: '0',
      width: 'auto',
      height: 'auto',
      margin: '0',
      padding: '0',
      border: '0',
      zIndex: '2147483646',
      pointerEvents: 'none',
      overflow: 'visible',
      transform: 'none',
      filter: 'none',
    });
  }

  function destroyOverlay() {
    if (overlayState) {
      const { video, onTime, onSeek, onResize, onInterval, el } = overlayState;
      if (video) {
        video.removeEventListener('timeupdate', onTime);
        video.removeEventListener('seeked', onSeek);
        video.removeEventListener('play', onTime);
      }
      window.removeEventListener('resize', onResize);
      if (onInterval) clearInterval(onInterval);
      if (el && el.parentNode) el.parentNode.removeChild(el);
      overlayState = null;
    }
    document.getElementById(OVERLAY_ID)?.remove();
  }

  function depthTextShadow(depth) {
    switch (depth) {
      case 'flat':
        return 'none';
      case 'shadow':
        return '0 2px 4px rgba(0,0,0,0.85), 0 4px 10px rgba(0,0,0,0.45)';
      case 'raised':
        return '0 -1px 0 rgba(255,255,255,0.55), 0 2px 3px rgba(0,0,0,0.85)';
      case 'inset':
        return '0 1px 0 rgba(255,255,255,0.25), 0 -1px 2px rgba(0,0,0,0.9)';
      case 'outline':
      default:
        return (
          '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000,' +
          '0 2px 4px rgba(0,0,0,0.65)'
        );
    }
  }

  /** Soft dark halo that follows glyph shapes (no solid caption plate). */
  function softHaloShadow(hardness, radiusPx) {
    const a = Math.max(0, Math.min(1, hardness));
    const r = Math.max(2, Math.min(48, radiusPx || 16));
    const stops = [
      { t: 0.12, m: 0.95 },
      { t: 0.28, m: 0.85 },
      { t: 0.48, m: 0.65 },
      { t: 0.7, m: 0.4 },
      { t: 1, m: 0.18 },
    ];
    return stops
      .map(({ t, m }) => `0 0 ${(r * t).toFixed(1)}px rgba(0,0,0,${(a * m).toFixed(3)})`)
      .join(', ');
  }

  function applyCaptionAppearance(caption, inner, style) {
    const s = style || getCaptionStyle();
    const size = Math.max(10, Math.min(72, Number(s.fontSize) || 24));
    const alpha = Math.max(0, Math.min(100, Number(s.bgOpacity ?? 72))) / 100;
    const radius = Math.max(2, Math.min(48, Number(s.blurRadius ?? 16)));
    caption.style.color = s.color || '#ffffff';
    caption.style.fontFamily = s.fontFamily || DEFAULT_CAPTION_STYLE.fontFamily;
    caption.style.fontSize = `${size}px`;
    caption.style.lineHeight = '1.35';
    caption.style.pointerEvents = 'none';
    caption.style.filter = 'none';

    const bg = s.background || 'box';
    const depth = s.depth || 'outline';
    const depthShadow = depthTextShadow(depth);

    inner.style.display = 'inline-block';
    inner.style.whiteSpace = 'pre-wrap';
    inner.style.border = 'none';
    inner.style.color = 'inherit';
    inner.style.font = 'inherit';
    inner.style.backdropFilter = 'none';
    inner.style.webkitBackdropFilter = 'none';

    if (bg === 'soft') {
      // Blurred radius around glyphs — looks like a background without a box
      inner.style.background = 'transparent';
      inner.style.padding = '0.05em 0.15em';
      inner.style.borderRadius = '0';
      const halo = softHaloShadow(alpha, radius);
      caption.style.textShadow = depth === 'flat' ? halo : `${halo}, ${depthShadow}`;
      caption.style.filter =
        alpha > 0
          ? `drop-shadow(0 0 ${Math.max(1, radius * 0.08).toFixed(1)}px rgba(0,0,0,${(alpha * 0.75).toFixed(3)}))`
          : 'none';
    } else if (bg === 'plate') {
      inner.style.background = `rgba(0,0,0,${(alpha * 0.65).toFixed(3)})`;
      inner.style.padding = '0.15em 0.5em';
      inner.style.borderRadius = '0.55em';
      inner.style.backdropFilter = 'blur(8px)';
      inner.style.webkitBackdropFilter = 'blur(8px)';
      caption.style.textShadow = depthShadow;
    } else if (bg === 'rounded') {
      inner.style.background = `rgba(0,0,0,${alpha.toFixed(3)})`;
      inner.style.padding = '0.15em 0.5em';
      inner.style.borderRadius = '0.55em';
      caption.style.textShadow = depthShadow;
    } else {
      // box — classic solid caption plate
      inner.style.background = `rgba(0,0,0,${alpha.toFixed(3)})`;
      inner.style.padding = '0.15em 0.5em';
      inner.style.borderRadius = '0.12em';
      caption.style.textShadow = depthShadow;
    }
  }

  function ensureOverlayRoot() {
    let host = document.getElementById(OVERLAY_ID);
    if (!host) {
      host = document.createElement('div');
      host.id = OVERLAY_ID;
    }
    placeOverlayHost(host);
    let caption = host.querySelector('.nepu-cap-text');
    if (!caption) {
      caption = document.createElement('div');
      caption.className = 'nepu-cap-text';
      Object.assign(caption.style, {
        position: 'absolute',
        left: '50%',
        bottom: '72px',
        top: 'auto',
        maxWidth: '90%',
        textAlign: 'center',
        display: 'none',
        zIndex: '2147483647',
        pointerEvents: 'none',
        visibility: 'visible',
        opacity: '1',
      });
      const inner = document.createElement('span');
      inner.className = 'nepu-cap-inner';
      caption.appendChild(inner);
      host.appendChild(caption);
    }
    const inner = caption.querySelector('.nepu-cap-inner') || caption.firstElementChild;
    applyCaptionAppearance(caption, inner, getCaptionStyle());
    return { host, caption, inner };
  }

  /** Video rect in top-window viewport coords (handles same-origin iframes). */
  function getPositionRect(video) {
    if (!video) {
      return { left: 0, top: 0, width: 0, height: 0, bottom: 0, right: 0 };
    }
    const vr = video.getBoundingClientRect();
    let left = vr.left;
    let top = vr.top;
    let win = video.ownerDocument && video.ownerDocument.defaultView;
    try {
      while (win && win !== window && win.frameElement) {
        const fr = win.frameElement.getBoundingClientRect();
        left += fr.left;
        top += fr.top;
        win = win.parent;
      }
    } catch (_) {
      /* cross-origin frame walk failed — use local rect */
    }
    const width = vr.width || video.clientWidth || 0;
    const height = vr.height || video.clientHeight || 0;
    return {
      left,
      top,
      width,
      height,
      bottom: top + height,
      right: left + width,
    };
  }

  function positionOverlay(video, caption) {
    if (!video || !caption) return false;
    const host = caption.parentElement;
    if (!host) return false;

    const rect = getPositionRect(video);
    // Prefer layout size; fall back to intrinsic media size mapped into layout box
    let w = rect.width;
    let h = rect.height;
    if (w < 40 || h < 40) {
      if (video.videoWidth > 0 && video.clientWidth > 0) {
        w = video.clientWidth;
        h = video.clientHeight;
      }
    }
    if (w < 40 || h < 40) return false;

    const style = getCaptionStyle();
    const hx = Math.max(0, Math.min(100, Number(style.horizontal) || 50)) / 100;
    let bottomPx = Math.max(0, Number(style.bottomPx) || 72);
    bottomPx = Math.min(bottomPx, Math.max(0, h - 12));

    // Always absolute inside the full-bleed host (avoids fixed-position containing-block bugs)
    const hr = host.getBoundingClientRect();
    const x = rect.left + w * hx - hr.left;
    const y = rect.top + h - bottomPx - hr.top;

    caption.style.position = 'absolute';
    caption.style.maxWidth = `${Math.round(w * 0.9)}px`;
    caption.style.textAlign = 'center';
    caption.style.zIndex = '2147483647';
    caption.style.pointerEvents = 'none';
    caption.style.visibility = 'visible';
    caption.style.opacity = '1';
    caption.style.left = `${Math.round(x)}px`;
    caption.style.top = `${Math.round(y)}px`;
    caption.style.bottom = 'auto';
    caption.style.right = 'auto';
    caption.style.transform = 'translate(-50%, -100%)';
    return true;
  }

  function refreshOverlayStyle() {
    if (!overlayState) return;
    const root = ensureOverlayRoot();
    applyCaptionAppearance(root.caption, root.inner, getCaptionStyle());
    if (overlayState.video) positionOverlay(overlayState.video, root.caption);
    if (overlayState.onTime) overlayState.onTime();
  }

  function setNativeTracksMode(mode) {
    for (const video of findVideos()) {
      try {
        const list = video.textTracks;
        for (let i = 0; i < list.length; i++) {
          const track = list[i];
          if (track && track.label && String(track.label).startsWith('Nepu OS:')) {
            track.mode = mode;
          }
        }
      } catch (_) {
        /* ignore */
      }
    }
  }

  /** Overlay is the styled visual path; native tracks stay hidden to avoid doubles. */
  function applyCaptionsVisibility() {
    const hidden = getCaptionsHidden();
    const fs = getFullscreenElement();
    const videoFs = fs && fs.tagName === 'VIDEO';

    if (overlayState && overlayState.el) {
      placeOverlayHost(overlayState.el);
      const caption = overlayState.el.querySelector('.nepu-cap-text');
      if (caption && (hidden || videoFs)) caption.style.display = 'none';
    }

    // When the <video> itself is fullscreen, overlays often can't paint — use native track
    if (videoFs && !hidden) {
      setNativeTracksMode('showing');
    } else {
      setNativeTracksMode('disabled');
      if (overlayState && overlayState.onTime && !hidden) {
        overlayState.onTime();
      }
    }
  }

  function injectOverlay(video, vttText) {
    destroyOverlay();
    const cues = parseVttCues(vttText);
    const { host, caption, inner } = ensureOverlayRoot();
    let lastText = '';
    let boundVideo = video;

    const bindVideo = (v) => {
      if (!v || v === boundVideo) return;
      if (boundVideo) {
        boundVideo.removeEventListener('timeupdate', sync);
        boundVideo.removeEventListener('seeked', sync);
        boundVideo.removeEventListener('play', sync);
      }
      boundVideo = v;
      boundVideo.addEventListener('timeupdate', sync);
      boundVideo.addEventListener('seeked', sync);
      boundVideo.addEventListener('play', sync);
      if (overlayState) overlayState.video = boundVideo;
    };

    const sync = () => {
      const best = pickBestVideo(findVideos()) || boundVideo;
      if (best && best !== boundVideo) bindVideo(best);
      if (!boundVideo) return;

      placeOverlayHost(host);
      const fs = getFullscreenElement();
      if (fs && fs.tagName === 'VIDEO') {
        caption.style.display = 'none';
        if (!getCaptionsHidden()) setNativeTracksMode('showing');
        return;
      }
      if (getCaptionsHidden()) {
        caption.style.display = 'none';
        return;
      }
      const placed = positionOverlay(boundVideo, caption);
      if (!placed) {
        caption.style.display = 'none';
        return;
      }
      const t = (boundVideo.currentTime || 0) - getTimingOffset();
      const cue = cues.find((c) => t >= c.start && t <= c.end);
      const next = cue ? cue.text : '';
      if (next !== lastText) {
        lastText = next;
        inner.textContent = next || '';
      }
      caption.style.display = next ? 'block' : 'none';
    };

    const onResize = () => {
      placeOverlayHost(host);
      sync();
    };
    boundVideo.addEventListener('timeupdate', sync);
    boundVideo.addEventListener('seeked', sync);
    boundVideo.addEventListener('play', sync);
    window.addEventListener('resize', onResize);
    const onInterval = setInterval(sync, 200);
    overlayState = { video: boundVideo, onTime: sync, onSeek: sync, onResize, onInterval, el: host };
    host.dataset.nepuCues = String(cues.length);
    sync();
    return { method: 'overlay', cueCount: cues.length };
  }

  function injectNativeTrack(video, blobUrl, { language, label, show }) {
    removeInjectedTracks(video);
    const track = document.createElement('track');
    track.kind = 'subtitles';
    track.srclang = language || 'en';
    track.label = label || `Nepu OS: ${language || 'en'}`;
    track.src = blobUrl;
    track.default = false;
    track.dataset.nepuSub = '1';
    video.appendChild(track);

    const mode = show ? 'showing' : 'hidden';
    const enable = () => {
      try {
        const tracks = video.textTracks;
        for (let i = 0; i < tracks.length; i++) {
          const tt = tracks[i];
          if (tt && (tt.label === track.label || tt.language === track.srclang)) {
            tt.mode = getCaptionsHidden() ? 'disabled' : mode;
          } else if (tt && tt.kind === 'subtitles') {
            tt.mode = 'disabled';
          }
        }
      } catch (_) {
        /* ignore */
      }
    };
    track.addEventListener('load', enable);
    setTimeout(enable, 200);
    setTimeout(enable, 800);
    return { method: 'native-track' };
  }

  function tryLibraryInject(blobUrl, { language, label }, vttText, video) {
    // video.js
    try {
      if (typeof window.videojs === 'function') {
        const players = window.videojs.getPlayers ? window.videojs.getPlayers() : {};
        const list = Object.values(players || {}).filter(Boolean);
        const player =
          list[0] ||
          (video &&
            window.videojs.getPlayer &&
            video.playerId &&
            window.videojs.getPlayer(video.playerId));
        if (player && player.addRemoteTextTrack) {
          player.addRemoteTextTrack(
            {
              kind: 'subtitles',
              src: blobUrl,
              srclang: language || 'en',
              label: label || `Nepu OS: ${language || 'en'}`,
              default: true,
            },
            false
          );
          return { method: 'videojs' };
        }
      }
    } catch (_) {
      /* ignore */
    }

    // JW Player
    try {
      if (typeof window.jwplayer === 'function') {
        const jw = window.jwplayer();
        if (jw && typeof jw.addCaptions === 'function') {
          jw.addCaptions({
            file: blobUrl,
            label: label || language || 'OpenSubtitles',
            kind: 'captions',
            default: true,
          });
          return { method: 'jwplayer' };
        }
        if (jw && typeof jw.load === 'function' && typeof jw.getPlaylist === 'function') {
          /* older APIs vary; fall through */
        }
      }
    } catch (_) {
      /* ignore */
    }

    // Plyr
    try {
      if (window.Plyr && video) {
        const plyr = video.plyr || (window.plyr && window.plyr.instances && window.plyr.instances[0]);
        if (plyr) {
          injectNativeTrack(video, blobUrl, { language, label, show: false });
          return { method: 'plyr-native' };
        }
      }
    } catch (_) {
      /* ignore */
    }

    return null;
  }

  function injectSubtitles(vttText, meta) {
    const language = meta.language || 'en';
    const label = `Nepu OS: ${meta.label || language}`;
    revokeActiveBlob();
    destroyOverlay();

    // Always re-enable captions when injecting a new file
    setCaptionsHidden(false);

    const detection = detectCrossOriginPlayerOnly();
    const video = pickBestVideo(detection.videos);

    if (!video && detection.blocked) {
      return {
        ok: false,
        reason: 'cross-origin-iframe',
        embedHints: detection.embedHints,
        message:
          'Player appears to be inside a cross-origin iframe. Outer-page injection cannot reach it.',
      };
    }

    if (!video) {
      activeBlobUrl = vttBlobUrl(vttText);
      return {
        ok: false,
        reason: 'no-video',
        message: 'No <video> element found yet. Captions will inject automatically once a player appears.',
        pendingVtt: true,
      };
    }

    const cueCount = parseVttCues(vttText).length;
    if (!cueCount) {
      return {
        ok: false,
        reason: 'no-cues',
        message:
          'Subtitle downloaded but no cues could be parsed (unexpected format). Try another candidate.',
      };
    }

    activeBlobUrl = vttBlobUrl(vttText);
    try {
      injectNativeTrack(video, activeBlobUrl, { language, label, show: false });
    } catch (_) {
      /* ignore */
    }
    const overlay = injectOverlay(video, vttText);
    applyCaptionsVisibility();
    return {
      ok: true,
      method: overlay.method,
      video,
      cueCount: overlay.cueCount || cueCount,
    };
  }

  // ---------------------------------------------------------------------------
  // 6. Message API (popup "Subtitles" tab talks to this content script)
  // ---------------------------------------------------------------------------
  //
  // The in-page shadow-DOM picker panel is gone; every action below is
  // invoked by a chrome.runtime message from popup/popup.js instead of a
  // DOM click handler, and returns its result instead of writing into a
  // status <div>. See the chrome.runtime.onMessage listener near the
  // bottom of this file for the full SUB_* message contract.

  const state = {
    candidates: [],
    tmdbResults: [],
    parentImdbId: '',
    parentTmdbId: '',
    hiFilter: 'all', // all | hi | nonhi
    lang: getPreferredLang(),
    remember: true,
    pendingVtt: null,
    pendingMeta: null,
    autoApplyAttempted: false,
  };

  function filterCandidates(list) {
    const mode = state.hiFilter;
    if (mode === 'hi') return list.filter((c) => c.hearingImpaired);
    if (mode === 'nonhi') return list.filter((c) => !c.hearingImpaired);
    return list;
  }

  /** Returns an error response object if the key is missing, else null. */
  function requireApiKey() {
    if (getApiKey()) return null;
    openExtensionSettings();
    return {
      ok: false,
      error: "OpenSubtitles API key required — opening the extension's Settings…",
      needsSettings: true,
    };
  }

  function requireTmdbKey() {
    if (getTmdbApiKey()) return null;
    openExtensionSettings();
    return {
      ok: false,
      error: "TMDB API key required — opening the extension's Settings…",
      needsSettings: true,
    };
  }

  function errMsg(err, fallback) {
    return (err && err.message) || fallback || 'Error';
  }

  async function handleSearch(params) {
    const missing = requireApiKey();
    if (missing) return missing;
    const p = params || {};
    const lang = String(p.lang || state.lang || getPreferredLang()).trim() || 'en';
    state.lang = lang;
    state.hiFilter = p.hi || state.hiFilter || 'all';
    state.remember = p.remember !== false;
    gmSet(STORAGE.preferredLang, lang);
    const season = p.season === '' || p.season == null ? null : Number(p.season);
    const episode = p.episode === '' || p.episode == null ? null : Number(p.episode);
    try {
      const candidates = await osSearch({
        query: p.query || '',
        languages: lang,
        imdbId: p.imdbId || '',
        tmdbId: p.tmdbId || '',
        parentImdbId: state.parentImdbId,
        parentTmdbId: state.parentTmdbId,
        season: Number.isFinite(season) ? season : null,
        episode: Number.isFinite(episode) ? episode : null,
      });
      state.candidates = candidates;
      return { ok: true, candidates: filterCandidates(candidates), total: candidates.length };
    } catch (err) {
      return { ok: false, error: errMsg(err, 'Search failed') };
    }
  }

  function handleSetHiFilter(hi) {
    state.hiFilter = hi || 'all';
    return { ok: true, candidates: filterCandidates(state.candidates) };
  }

  async function handleDownloadCandidate(fileId, query) {
    const missing = requireApiKey();
    if (missing) return missing;
    const candidate = state.candidates.find((c) => c.fileId === fileId) || { fileId };
    try {
      const file = await osDownload(fileId);
      const vtt = srtToVtt(file.content);
      const meta = {
        language: candidate.language || state.lang || 'en',
        label: candidate.release || candidate.filename || candidate.language,
      };
      state.pendingVtt = vtt;
      state.pendingMeta = meta;
      savePageCaptions(vtt, meta, { fileId, query: query || '' });
      if (state.remember) {
        saveLastPick({ fileId, language: meta.language, label: meta.label, query: query || '' });
      }
      const result = injectSubtitles(vtt, meta);
      return {
        ok: !!result.ok,
        method: result.method,
        cueCount: result.cueCount,
        remaining: file.remaining,
        reason: result.reason,
        message: result.message,
        embedHints: result.embedHints,
      };
    } catch (err) {
      return { ok: false, error: errMsg(err, 'Download failed') };
    }
  }

  async function handleReloadLast() {
    const last = getLastPickForPage();
    if (!last || !last.fileId) {
      return { ok: false, error: 'No remembered subtitle for this page.' };
    }
    const missing = requireApiKey();
    if (missing) return missing;
    try {
      const file = await osDownload(last.fileId);
      const vtt = srtToVtt(file.content);
      const meta = { language: last.language || 'en', label: last.label || last.language };
      state.pendingVtt = vtt;
      state.pendingMeta = meta;
      savePageCaptions(vtt, meta, { fileId: last.fileId, query: last.query || '' });
      const result = injectSubtitles(vtt, meta);
      return {
        ok: !!result.ok,
        method: result.method,
        cueCount: result.cueCount,
        reason: result.reason,
        message: result.message,
      };
    } catch (err) {
      return { ok: false, error: errMsg(err, 'Reload failed') };
    }
  }

  async function handleTmdbSearch(query) {
    const missing = requireTmdbKey();
    if (missing) return missing;
    let q = String(query || '').trim();
    q = q
      .replace(/\b[Ss]\d{1,2}\s*[Ee]\d{1,3}\b/g, '')
      .replace(/\b\d{1,2}\s*[xX]\s*\d{1,3}\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!q) return { ok: false, error: 'Enter a title to search on TMDB.' };
    try {
      const results = await tmdbSearchMulti(q);
      state.tmdbResults = results;
      return { ok: true, results };
    } catch (err) {
      return { ok: false, error: errMsg(err, 'TMDB search failed') };
    }
  }

  async function handleTmdbPick(item, season, episode) {
    const missing = requireTmdbKey();
    if (missing) return missing;
    if (!item) return { ok: false, error: 'No TMDB item provided.' };
    const seasonEmpty = season === '' || season == null;
    const episodeEmpty = episode === '' || episode == null;
    if (item.mediaType === 'tv' && (seasonEmpty || episodeEmpty)) {
      return { ok: false, error: 'TV pick needs Season + Episode filled (or detected from the page).' };
    }
    try {
      const match = await tmdbResolvePick(item, season, episode);
      state.parentImdbId = match.parentImdbId || '';
      state.parentTmdbId = match.parentTmdbId || '';
      return {
        ok: true,
        query: match.query || match.title || '',
        imdbId: match.imdbId || match.episodeImdbId || match.parentImdbId || '',
        tmdbId: match.tmdbId || match.parentTmdbId || '',
        season: match.season != null && match.season !== '' ? match.season : null,
        episode: match.episode != null && match.episode !== '' ? match.episode : null,
      };
    } catch (err) {
      return { ok: false, error: errMsg(err, 'TMDB resolve failed') };
    }
  }

  function applyStylePatch(patch) {
    const merged = migrateCaptionStyle({ ...getCaptionStyle(), ...(patch || {}) });
    saveCaptionStyle(merged);
    refreshOverlayStyle();
    return merged;
  }

  function handleResetStyle() {
    saveCaptionStyle({ ...DEFAULT_CAPTION_STYLE });
    refreshOverlayStyle();
    return { ...DEFAULT_CAPTION_STYLE };
  }

  function handleSetTiming(offset, precise) {
    const clamped = setTimingOffset(offset, { precise });
    if (overlayState && overlayState.onTime) overlayState.onTime();
    return { offset: clamped, precise: getTimingPrecise() };
  }

  function handleSetTimingPrecise(on) {
    setTimingPrecise(!!on);
    if (!on) setTimingOffset(getTimingOffset(), { precise: false });
    if (overlayState && overlayState.onTime) overlayState.onTime();
    return { offset: getTimingOffset(), precise: getTimingPrecise() };
  }

  function handleResetTiming() {
    setTimingOffset(0, { precise: getTimingPrecise() });
    if (overlayState && overlayState.onTime) overlayState.onTime();
    return { offset: 0, precise: getTimingPrecise() };
  }

  function handleToggleCaptions(hidden) {
    setCaptionsHidden(hidden != null ? !!hidden : !getCaptionsHidden());
    applyCaptionsVisibility();
    return { hidden: getCaptionsHidden() };
  }

  function buildStateSnapshot() {
    const identified = identifyTitle();
    const detection = detectCrossOriginPlayerOnly();
    return {
      ok: true,
      identified,
      detect: {
        blocked: !!detection.blocked,
        videoCount: detection.videos ? detection.videos.length : 0,
        embedHints: detection.embedHints || [],
      },
      hasApiKey: !!getApiKey(),
      hasTmdbKey: !!getTmdbApiKey(),
      captionsHidden: getCaptionsHidden(),
      captionsLoaded: !!overlayState,
      style: getCaptionStyle(),
      timing: { offset: getTimingOffset(), precise: getTimingPrecise() },
      lastPick: getLastPickForPage(),
      candidates: filterCandidates(state.candidates),
      tmdbResults: state.tmdbResults,
      lang: state.lang,
      hiFilter: state.hiFilter,
      remember: state.remember,
    };
  }

  // ---------------------------------------------------------------------------
  // 6b. Auto-apply captions (Settings → "Auto-apply captions")
  // ---------------------------------------------------------------------------
  //
  // Best-effort: search using the page's identified title/season/episode and
  // inject the FIRST result, but only once per page load, only with an API
  // key set, and only when nothing is already loaded or being restored.

  async function maybeAutoApplyCaptions() {
    try {
      if (state.autoApplyAttempted) return;
      const settings = await NVT.getSettings();
      if (!settings.autoApplyCaptions) return;
      if (!getApiKey()) return;
      if (overlayState) return;
      const session = getPageSession();
      if (session && session.vtt) return; // already loaded / being restored
      if (!findVideos().length) return; // wait for a player before spending a search
      state.autoApplyAttempted = true;
      const identified = identifyTitle();
      const searchResult = await handleSearch({
        query: identified.query || identified.title,
        season: identified.season,
        episode: identified.episode,
        imdbId: identified.imdbId,
      });
      if (!searchResult.ok || !searchResult.candidates.length) return;
      await handleDownloadCandidate(
        searchResult.candidates[0].fileId,
        identified.query || identified.title
      );
    } catch (err) {
      console.debug('[Nepu Subtitles] auto-apply failed', err);
    }
  }

  // ---------------------------------------------------------------------------
  // 6c. Hotkeys — act directly on the page, so they still work without a
  // panel: Alt+arrows nudge caption position, Alt+C toggles captions, Alt+0
  // resets position. (Alt+S used to toggle the removed panel and has no
  // replacement — open the extension popup's Subtitles tab instead.)
  // ---------------------------------------------------------------------------

  function isTypingTarget(el) {
    if (!el || el === document.body || el === document.documentElement) return false;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    if (el.isContentEditable) return true;
    return false;
  }

  function nudgeCaptionPosition(dx, dy) {
    const style = getCaptionStyle();
    // ↑ increases bottomPx (captions move up); ← decreases horizontal %
    style.bottomPx = Math.max(0, Math.min(400, Math.round(Number(style.bottomPx) || 72) + dy));
    style.horizontal = Math.max(0, Math.min(100, Math.round(Number(style.horizontal) || 50) + dx));
    saveCaptionStyle(style);
    refreshOverlayStyle();
  }

  function hookHotkeys() {
    if (window.__nepuSubHotkeys) return;
    window.__nepuSubHotkeys = true;
    document.addEventListener(
      'keydown',
      (e) => {
        if (!e.altKey || e.ctrlKey || e.metaKey) return;
        if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;

        const key = e.key;
        const fine = e.shiftKey;
        const stepPx = fine ? 2 : 8;
        const stepH = fine ? 1 : 3;

        if (key === 'ArrowUp') {
          e.preventDefault();
          nudgeCaptionPosition(0, stepPx);
        } else if (key === 'ArrowDown') {
          e.preventDefault();
          nudgeCaptionPosition(0, -stepPx);
        } else if (key === 'ArrowLeft') {
          e.preventDefault();
          nudgeCaptionPosition(-stepH, 0);
        } else if (key === 'ArrowRight') {
          e.preventDefault();
          nudgeCaptionPosition(stepH, 0);
        } else if (key === 'c' || key === 'C') {
          e.preventDefault();
          setCaptionsHidden(!getCaptionsHidden());
          applyCaptionsVisibility();
        } else if (key === '0') {
          e.preventDefault();
          const style = getCaptionStyle();
          style.bottomPx = DEFAULT_CAPTION_STYLE.bottomPx;
          style.horizontal = DEFAULT_CAPTION_STYLE.horizontal;
          saveCaptionStyle(style);
          refreshOverlayStyle();
        }
      },
      true
    );
  }
  // ---------------------------------------------------------------------------
  // 7. Boot / SPA hooks
  // ---------------------------------------------------------------------------

  let lastPath = location.pathname;
  let videoObserver = null;

  function onNavigated() {
    if (location.pathname === lastPath) return;
    const previousPath = lastPath;
    lastPath = location.pathname;

    // Leaving a video/page: drop timing + cached captions for the previous page
    clearLastPickForPage(previousPath);
    clearPageSession();
    destroyOverlay();
    revokeActiveBlob();
    state.candidates = [];
    state.tmdbResults = [];
    state.pendingVtt = null;
    state.pendingMeta = null;
    state.parentImdbId = '';
    state.parentTmdbId = '';
    state.autoApplyAttempted = false;
    ensureWatchlistButton();
    maybeAutoApplyCaptions();
  }

  function tryRestorePageSession() {
    const session = getPageSession();
    if (!session || !session.vtt) return;
    const meta = session.meta || { language: 'en', label: 'Restored' };
    state.pendingVtt = session.vtt;
    state.pendingMeta = meta;
    injectSubtitles(session.vtt, meta);
  }

  function hookHistory() {
    const wrap = (name) => {
      const orig = history[name];
      if (typeof orig !== 'function') return;
      history[name] = function (...args) {
        const ret = orig.apply(this, args);
        queueMicrotask(onNavigated);
        return ret;
      };
    };
    wrap('pushState');
    wrap('replaceState');
    window.addEventListener('popstate', () => queueMicrotask(onNavigated));
  }

  function watchDom() {
    if (videoObserver) return;
    videoObserver = new MutationObserver(() => {
      if (state.pendingVtt && state.pendingMeta) {
        const videos = findVideos();
        if (videos.length) {
          const vtt = state.pendingVtt;
          const meta = state.pendingMeta;
          state.pendingVtt = null;
          injectSubtitles(vtt, meta);
        }
      }
      // Detect SPA content swaps without history change
      if (location.pathname !== lastPath) onNavigated();
      ensureWatchlistButton();
      maybeAutoApplyCaptions();
    });
    videoObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  function hookFullscreen() {
    const onFs = () => {
      applyCaptionsVisibility();
      if (overlayState && overlayState.el) placeOverlayHost(overlayState.el);
      if (overlayState && overlayState.onTime) overlayState.onTime();
    };
    document.addEventListener('fullscreenchange', onFs);
    document.addEventListener('webkitfullscreenchange', onFs);
  }
  // ---------------------------------------------------------------------------
  // Watchlist button — injected next to the page's own like/dislike buttons
  // (".action-btns") so users can add the current title without opening the
  // extension popup. Icon-only by design; Backed by the shared NVT watchlist
  // store.
  // ---------------------------------------------------------------------------
  function currentPageIdentity() {
    return {
      host: location.hostname,
      path: location.pathname + location.search,
      url: location.href,
    };
  }

  // Fully inline-styled so it renders correctly regardless of the host
  // page's own CSS (avoids depending on ".action-btn" rules meant for the
  // site's sprite icons, which may hide/clip an unrelated child). Icon
  // only, no background/border box — just the glyph, matching the site's
  // own bare like/dislike icons.
  const NVT_WATCHLIST_ICON_DEFAULT = '#b5b5be';
  const NVT_WATCHLIST_ICON_ACTIVE = '#5b8cff';
  const NVT_WATCHLIST_BTN_STYLE =
    'display:inline-flex;align-items:center;justify-content:center;' +
    'width:26px;height:26px;margin:2px 0 2px 8px;background:transparent;' +
    'border:none;color:' + NVT_WATCHLIST_ICON_DEFAULT + ';' +
    'cursor:pointer;user-select:none;transition:color .15s ease;' +
    'vertical-align:middle;';

  function buildWatchlistButtonEl() {
    const btn = document.createElement('div');
    btn.className = 'nvt-watchlist-btn';
    btn.setAttribute('role', 'button');
    btn.setAttribute('aria-label', 'Add to watchlist');
    btn.style.cssText = NVT_WATCHLIST_BTN_STYLE;
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linejoin="round" style="display:block;flex:0 0 auto">' +
      '<path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z"/></svg>';
    btn.addEventListener('mouseenter', () => {
      btn.style.color = NVT_WATCHLIST_ICON_ACTIVE;
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.color = btn.classList.contains('active')
        ? NVT_WATCHLIST_ICON_ACTIVE
        : NVT_WATCHLIST_ICON_DEFAULT;
    });
    btn.addEventListener('click', () => toggleWatchlist(btn));
    return btn;
  }

  /**
   * If this show is already bookmarked but the page has moved on to a
   * different episode, silently move the bookmark forward — no click
   * required, mirrors how Continue Watching updates itself while playing.
   * Movies and "not bookmarked yet" are left alone (never auto-adds).
   */
  async function syncWatchlistBookmark(host, path) {
    try {
      const existing = await NVT.getWatchlistFor(host, path);
      if (!existing) return null;
      const identified = identifyTitle();
      const hasSe = identified.season != null && identified.episode != null;
      if (!hasSe) return existing;
      if (existing.season === identified.season && existing.episode === identified.episode) {
        return existing;
      }
      const poster = metaContent('meta[property="og:image"]') || existing.poster || '';
      return await NVT.addWatchlist({
        host,
        path,
        url: location.href,
        title: identified.title || existing.title,
        poster,
        season: identified.season,
        episode: identified.episode,
        mediaType: 'tv',
      });
    } catch (err) {
      console.debug('[Nepu Subtitles] watchlist auto-update failed', err);
      return null;
    }
  }

  async function updateWatchlistButtonState(btn) {
    try {
      const { host, path } = currentPageIdentity();
      const existing = await syncWatchlistBookmark(host, path);
      const inList = !!existing;
      btn.classList.toggle('active', inList);
      btn.style.color = inList ? NVT_WATCHLIST_ICON_ACTIVE : NVT_WATCHLIST_ICON_DEFAULT;
      btn.title = inList ? 'Remove from watchlist' : 'Add to watchlist';
      btn.setAttribute('aria-label', btn.title);
    } catch (err) {
      console.debug('[Nepu Subtitles] watchlist state sync failed', err);
    }
  }

  async function toggleWatchlist(btn) {
    try {
      const { host, path, url } = currentPageIdentity();
      const existing = await NVT.getWatchlistFor(host, path);
      if (existing) {
        await NVT.removeWatchlist(existing.id);
      } else {
        const identified = identifyTitle();
        const hasSe = identified.season != null && identified.episode != null;
        const isTv = hasSe || identified.mediaType === 'tv' || /\/(?:show|tv)\//i.test(location.pathname);
        const title = identified.title || document.title;
        const poster = metaContent('meta[property="og:image"]');
        await NVT.addWatchlist({
          host,
          path,
          url,
          title,
          poster: poster || '',
          season: hasSe ? identified.season : null,
          episode: hasSe ? identified.episode : null,
          mediaType: isTv ? 'tv' : 'movie',
        });
      }
      await updateWatchlistButtonState(btn);
    } catch (err) {
      console.debug('[Nepu Subtitles] watchlist toggle failed', err);
    }
  }

  /** Matches the same URL shapes parseNepuSlug()/identifyTitle() treat as a
   * real title page — home/browse/search pages don't have a title to add. */
  function isLikelyTitlePage() {
    return /\/(?:movie|tv|watch|anime|show)\//i.test(location.pathname);
  }

  function ensureWatchlistButton() {
    try {
      if (!isLikelyTitlePage()) {
        const stale = document.getElementById('nvt-watchlist-floating');
        if (stale) stale.remove();
        const container = document.querySelector('.action-btns');
        const inline = container && container.querySelector('.nvt-watchlist-btn');
        if (inline) inline.remove();
        return;
      }

      const container = document.querySelector('.action-btns');
      if (container) {
        const floating = document.getElementById('nvt-watchlist-floating');
        if (floating) floating.remove();
        let btn = container.querySelector('.nvt-watchlist-btn');
        if (!btn) {
          btn = buildWatchlistButtonEl();
          container.appendChild(btn);
        }
        updateWatchlistButtonState(btn);
        return;
      }

      // Fallback for title-page themes without ".action-btns": pin a
      // floating button so "Add to Watchlist" is still reachable, but only
      // on an actual title page — never on home/browse/search.
      let btn = document.getElementById('nvt-watchlist-floating');
      if (!btn) {
        btn = buildWatchlistButtonEl();
        btn.id = 'nvt-watchlist-floating';
        btn.style.position = 'fixed';
        btn.style.right = '16px';
        btn.style.bottom = '16px';
        btn.style.margin = '0';
        btn.style.zIndex = '2147483000';
        btn.style.boxShadow = '0 4px 16px rgba(0,0,0,0.4)';
        btn.style.background = '#161a22';
        btn.style.borderRadius = '6px';
        btn.style.padding = '5px';
        (document.body || document.documentElement).appendChild(btn);
      }
      updateWatchlistButtonState(btn);
    } catch (err) {
      console.debug('[Nepu Subtitles] watchlist button injection failed', err);
    }
  }

  function boot() {
    hookHistory();
    watchDom();
    hookFullscreen();
    hookHotkeys();
    tryRestorePageSession();
    ensureWatchlistButton();
    maybeAutoApplyCaptions();
  }

  refreshSubAuthCache().finally(() => {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot);
    } else {
      boot();
    }
  });

  // ---------------------------------------------------------------------------
  // Message API entry point — see section 6 above for each handler.
  // ---------------------------------------------------------------------------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('SUB_')) {
      return false;
    }
    (async () => {
      try {
        switch (msg.type) {
          case 'SUB_GET_STATE':
            sendResponse(buildStateSnapshot());
            break;
          case 'SUB_SEARCH':
            sendResponse(await handleSearch(msg.payload));
            break;
          case 'SUB_SET_HI_FILTER':
            sendResponse(handleSetHiFilter(msg.payload && msg.payload.hi));
            break;
          case 'SUB_DOWNLOAD_CANDIDATE':
            sendResponse(
              await handleDownloadCandidate(
                msg.payload && msg.payload.fileId,
                msg.payload && msg.payload.query
              )
            );
            break;
          case 'SUB_RELOAD_LAST':
            sendResponse(await handleReloadLast());
            break;
          case 'SUB_TMDB_SEARCH':
            sendResponse(await handleTmdbSearch(msg.payload && msg.payload.query));
            break;
          case 'SUB_TMDB_PICK':
            sendResponse(
              await handleTmdbPick(
                msg.payload && msg.payload.item,
                msg.payload && msg.payload.season,
                msg.payload && msg.payload.episode
              )
            );
            break;
          case 'SUB_SET_STYLE':
            sendResponse({ ok: true, style: applyStylePatch(msg.payload) });
            break;
          case 'SUB_RESET_STYLE':
            sendResponse({ ok: true, style: handleResetStyle() });
            break;
          case 'SUB_SET_TIMING':
            sendResponse({
              ok: true,
              ...handleSetTiming(msg.payload && msg.payload.offset, msg.payload && msg.payload.precise),
            });
            break;
          case 'SUB_SET_TIMING_PRECISE':
            sendResponse({ ok: true, ...handleSetTimingPrecise(msg.payload && msg.payload.on) });
            break;
          case 'SUB_RESET_TIMING':
            sendResponse({ ok: true, ...handleResetTiming() });
            break;
          case 'SUB_TOGGLE_CAPTIONS':
            sendResponse({ ok: true, ...handleToggleCaptions(msg.payload && msg.payload.hidden) });
            break;
          default:
            sendResponse({ ok: false, error: 'Unknown message type: ' + msg.type });
        }
      } catch (err) {
        sendResponse({ ok: false, error: (err && err.message) || 'Handler failed' });
      }
    })();
    return true; // keep the message channel open for the async response
  });
})();
