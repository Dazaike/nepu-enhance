(function () {
  'use strict';

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function emptyState(icon, text) {
    const div = document.createElement('div');
    div.className = 'empty-state';
    div.innerHTML = `<div class="empty-icon">${icon}</div><div class="empty-text">${escapeHtml(text)}</div>`;
    return div;
  }

  function wireThumbFallback(root) {
    const img = root.querySelector('.thumb-img');
    if (!img) return;
    img.addEventListener('error', () => {
      img.remove();
      const fb = root.querySelector('.thumb-fallback');
      if (fb) fb.hidden = false;
    });
  }

  function thumbMarkup(poster, size) {
    const img = poster ? `<img class="thumb-img" src="${escapeHtml(poster)}" alt="" />` : '';
    const cls = size ? `thumb thumb-${size}` : 'thumb';
    return `<div class="${cls}">${img}<div class="thumb-fallback" ${poster ? 'hidden' : ''}>&#127909;</div></div>`;
  }

  function formatClock(totalSeconds) {
    const s = Math.max(0, Math.round(Number(totalSeconds) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
    const ss = String(sec).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  function relativeTime(ms) {
    const diff = Date.now() - Number(ms || 0);
    if (!Number.isFinite(diff) || diff < 0) return 'just now';
    const min = Math.floor(diff / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.floor(hr / 24);
    if (day < 7) return `${day}d ago`;
    return new Date(ms).toLocaleDateString();
  }

  function seLabel(entry) {
    return entry.season != null && entry.episode != null
      ? `S${entry.season} E${entry.episode}`
      : '';
  }

  function progressText(entry, useTime) {
    if (useTime) return `${formatClock(entry.currentTime)} / ${formatClock(entry.duration)}`;
    const pct = Math.max(0, Math.min(100, Math.round((entry.progress || 0) * 100)));
    return `${pct}%`;
  }

  // Best-effort season/episode extraction from a URL's path/query, used
  // whenever we add something to the watchlist without a site-specific
  // parser (the Nepu injected button uses its own richer title parser
  // instead — see content/subtitles.js identifyTitle()).
  function parseSeasonEpisodeFromUrl(urlStr) {
    try {
      const u = new URL(urlStr);
      const path = u.pathname || '';
      let m = path.match(/season[/-](\d{1,2})[/-]episode[/-](\d{1,3})/i);
      if (m) return { season: Number(m[1]), episode: Number(m[2]) };
      m = path.match(/[/-][Ss](\d{1,2})[Ee](\d{1,3})(?:[/-]|$)/);
      if (m) return { season: Number(m[1]), episode: Number(m[2]) };
      m = (u.search || '').match(/[?&](?:season|s)=(\d{1,2})&(?:episode|e)=(\d{1,3})/i);
      if (m) return { season: Number(m[1]), episode: Number(m[2]) };
      return { season: null, episode: null };
    } catch (_) {
      return { season: null, episode: null };
    }
  }

  // ---------------------------------------------------------------------
  // View mode (list/grid) — independent per section, remembered across
  // popup opens. Deliberately NOT part of NVT settings: it's a display
  // preference, not watch data, and Continue Watching / Watchlist must be
  // switchable independently of each other.
  // ---------------------------------------------------------------------
  const VIEW_MODE_KEY = { continue: 'nvtViewContinue', watchlist: 'nvtViewWatchlist' };

  async function getViewMode(section) {
    const key = VIEW_MODE_KEY[section];
    const res = await chrome.storage.local.get(key);
    return res[key] === 'grid' ? 'grid' : 'list';
  }

  async function setViewMode(section, mode) {
    await chrome.storage.local.set({ [VIEW_MODE_KEY[section]]: mode });
  }

  function wireViewToggle(toggleEl, onPick) {
    const buttons = Array.from(toggleEl.querySelectorAll('.view-btn'));
    buttons.forEach((b) => b.addEventListener('click', () => onPick(b.dataset.view)));
    return {
      setActive(mode) {
        buttons.forEach((b) => b.classList.toggle('active', b.dataset.view === mode));
      },
    };
  }

  const state = { settings: null };

  // ---------------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------------
  const tabButtons = Array.from(document.querySelectorAll('.tab-btn'));
  const panels = {
    continue: document.getElementById('panel-continue'),
    watchlist: document.getElementById('panel-watchlist'),
    subtitles: document.getElementById('panel-subtitles'),
    settings: document.getElementById('panel-settings'),
  };

  function switchTab(name) {
    tabButtons.forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    Object.keys(panels).forEach((key) => panels[key].classList.toggle('active', key === name));
    if (name === 'subtitles') initSubtitlesTab();
  }

  tabButtons.forEach((btn) => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

  // ---------------------------------------------------------------------
  // Continue Watching
  // ---------------------------------------------------------------------
  const continueListEl = document.getElementById('continue-list');
  const clearHistoryBtn = document.getElementById('clear-history-btn');
  const continueViewToggle = wireViewToggle(
    document.getElementById('continue-view-toggle'),
    (mode) => {
      continueViewMode = mode;
      setViewMode('continue', mode);
      continueViewToggle.setActive(mode);
      renderContinue();
    }
  );
  let continueViewMode = 'list';

  function actionButtonsMarkup() {
    return `
      <button type="button" class="icon-btn resume-btn" title="Resume">&#9654;</button>
      <button type="button" class="icon-btn remove-btn" title="Remove">&#10005;</button>
    `;
  }

  function wireHistoryActions(root, entry) {
    root.querySelector('.resume-btn').addEventListener('click', () => {
      chrome.tabs.create({ url: entry.url });
    });
    root.querySelector('.remove-btn').addEventListener('click', async () => {
      await NVT.removeHistory(entry.id);
      renderContinue();
    });
  }

  function buildHistoryListRow(entry, pct, useTime) {
    const row = document.createElement('div');
    row.className = 'row';
    const se = seLabel(entry);
    const meta = `${se ? se + ' &middot; ' : ''}${progressText(entry, useTime)} &middot; ${relativeTime(entry.updatedAt)}`;
    row.innerHTML = `
      ${thumbMarkup(entry.poster, 'lg')}
      <div class="row-body">
        <div class="row-title" title="${escapeHtml(entry.title || entry.url || '')}">${escapeHtml(entry.title || entry.url || 'Untitled')}</div>
        <div class="row-meta">${meta}</div>
        <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
      </div>
      <div class="row-actions">${actionButtonsMarkup()}</div>
    `;
    wireThumbFallback(row);
    wireHistoryActions(row, entry);
    return row;
  }

  function buildHistoryGridItem(entry, pct, useTime) {
    const item = document.createElement('div');
    item.className = 'grid-item';
    const se = seLabel(entry);
    item.innerHTML = `
      <div class="grid-thumb">
        ${thumbMarkup(entry.poster)}
        ${se ? `<div class="grid-badge">${escapeHtml(se)}</div>` : ''}
        <div class="grid-overlay">
          <div class="grid-progress-track"><div class="grid-progress-fill" style="width:${pct}%"></div></div>
          <div class="grid-pct">${progressText(entry, useTime)} watched</div>
          <div class="grid-actions">${actionButtonsMarkup()}</div>
        </div>
      </div>
      <div class="grid-title" title="${escapeHtml(entry.title || entry.url || '')}">${escapeHtml(entry.title || entry.url || 'Untitled')}</div>
    `;
    wireThumbFallback(item);
    wireHistoryActions(item, entry);
    return item;
  }

  async function renderContinue() {
    const [history, settings] = await Promise.all([NVT.listHistory(), NVT.getSettings()]);
    state.settings = settings;

    const entries = (history || [])
      .filter((h) => h && !h.completed
        && (h.progress || 0) >= settings.minProgressToTrack
        && (h.progress || 0) < settings.completedThreshold)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    continueListEl.innerHTML = '';
    continueListEl.classList.toggle('grid', continueViewMode === 'grid');

    if (!entries.length) {
      continueListEl.appendChild(emptyState('&#127916;', 'Nothing in progress. Start watching something!'));
      return;
    }
    for (const entry of entries) {
      const pct = Math.max(0, Math.min(100, Math.round((entry.progress || 0) * 100)));
      const el = continueViewMode === 'grid'
        ? buildHistoryGridItem(entry, pct, settings.useTimeProgress)
        : buildHistoryListRow(entry, pct, settings.useTimeProgress);
      continueListEl.appendChild(el);
    }
  }

  clearHistoryBtn.addEventListener('click', async () => {
    if (!confirm('Clear all watch history? This cannot be undone.')) return;
    await NVT.clearHistory();
    renderContinue();
  });

  // ---------------------------------------------------------------------
  // Watchlist
  // ---------------------------------------------------------------------
  const watchlistListEl = document.getElementById('watchlist-list');
  const watchlistErrorEl = document.getElementById('watchlist-error');
  const addCurrentTabBtn = document.getElementById('add-current-tab-btn');
  const watchlistViewToggle = wireViewToggle(
    document.getElementById('watchlist-view-toggle'),
    (mode) => {
      watchlistViewMode = mode;
      setViewMode('watchlist', mode);
      watchlistViewToggle.setActive(mode);
      renderWatchlist();
    }
  );
  let watchlistViewMode = 'list';

  function seasonEpisodeLabel(item) {
    return item.season != null && item.episode != null
      ? `S${item.season} E${item.episode}`
      : 'Movie';
  }

  function wireWatchlistActions(root, item) {
    root.querySelector('.open-btn').addEventListener('click', () => chrome.tabs.create({ url: item.url }));
    root.querySelector('.remove-wl-btn').addEventListener('click', async () => {
      await NVT.removeWatchlist(item.id);
      renderWatchlist();
    });
    const clearBtn = root.querySelector('.clear-new-btn');
    if (clearBtn) {
      clearBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await NVT.clearNewReleaseBadge(item.id);
        renderWatchlist();
      });
    }
  }

  function buildWatchlistListRow(item) {
    const row = document.createElement('div');
    row.className = 'row';
    let meta = seasonEpisodeLabel(item);
    const hasNew = item.hasNewRelease && item.latestSeason != null && item.latestEpisode != null;
    if (hasNew) {
      meta += ` &middot; <span style="color:#10b981;font-weight:600">NEW S${item.latestSeason} E${item.latestEpisode}</span>`;
    }
    const clearNewBtn = hasNew
      ? `<button type="button" class="icon-btn clear-new-btn" title="Clear NEW badge (mark caught up)">✓</button>`
      : '';
    row.innerHTML = `
      ${thumbMarkup(item.poster, 'lg')}
      <div class="row-body">
        <div class="row-title" title="${escapeHtml(item.title || item.url || '')}">${escapeHtml(item.title || item.url || 'Untitled')}</div>
        <div class="row-meta">${meta}</div>
      </div>
      <div class="row-actions">
        ${clearNewBtn}
        <button type="button" class="icon-btn open-btn" title="Open">&#9654;</button>
        <button type="button" class="icon-btn remove-wl-btn" title="Remove">&#10005;</button>
      </div>
    `;
    wireThumbFallback(row);
    wireWatchlistActions(row, item);
    return row;
  }

  function buildWatchlistGridItem(item) {
    const se = seLabel(item);
    const el = document.createElement('div');
    el.className = 'grid-item';
    const hasNew = item.hasNewRelease && item.latestSeason != null && item.latestEpisode != null;
    let badgeHtml = '';
    if (hasNew) {
      badgeHtml = `<button type="button" class="grid-badge new-release clear-new-btn" title="Clear NEW badge (mark caught up)">NEW S${item.latestSeason} E${item.latestEpisode} · ✓</button>`;
    } else if (se) {
      badgeHtml = `<div class="grid-badge">${escapeHtml(se)}</div>`;
    }
    el.innerHTML = `
      <div class="grid-thumb">
        ${thumbMarkup(item.poster)}
        ${badgeHtml}
        <div class="grid-overlay">
          <div class="grid-se">${escapeHtml(seasonEpisodeLabel(item))}</div>
          <div class="grid-actions">
            <button type="button" class="icon-btn open-btn" title="Open">&#9654;</button>
            <button type="button" class="icon-btn remove-wl-btn" title="Remove">&#10005;</button>
          </div>
        </div>
      </div>
      <div class="grid-title" title="${escapeHtml(item.title || item.url || '')}">${escapeHtml(item.title || item.url || 'Untitled')}</div>
    `;
    wireThumbFallback(el);
    wireWatchlistActions(el, item);
    return el;
  }

  async function renderWatchlist() {
    const items = (await NVT.listWatchlist()).sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    watchlistListEl.innerHTML = '';
    watchlistListEl.classList.toggle('grid', watchlistViewMode === 'grid');

    if (!items.length) {
      watchlistListEl.appendChild(emptyState('&#128250;', 'Your watchlist is empty. Add pages you want to watch later.'));
      return;
    }
    for (const item of items) {
      const el = watchlistViewMode === 'grid'
        ? buildWatchlistGridItem(item)
        : buildWatchlistListRow(item);
      watchlistListEl.appendChild(el);
    }
  }

  function showWatchlistError(message) {
    watchlistErrorEl.textContent = message;
    watchlistErrorEl.hidden = false;
  }

  addCurrentTabBtn.addEventListener('click', async () => {
    watchlistErrorEl.hidden = true;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.url) throw new Error('No active tab found.');
      if (!/^https?:\/\//i.test(tab.url)) {
        throw new Error('This page cannot be added to the watchlist (unsupported URL).');
      }

      let scraped = { title: '', image: '' };
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => ({
            title: document.title,
            image: (document.querySelector('meta[property="og:image"]') || {}).content || '',
          }),
        });
        if (results && results[0] && results[0].result) scraped = results[0].result;
      } catch (err) {
        // Scripting may fail on restricted pages even though the URL looked
        // http(s) at this point (rare) — fall back to tab metadata only.
      }

      const u = new URL(tab.url);
      const se = parseSeasonEpisodeFromUrl(tab.url);
      await NVT.addWatchlist({
        host: u.hostname,
        path: u.pathname + u.search,
        url: tab.url,
        title: scraped.title || tab.title || u.hostname,
        poster: scraped.image || '',
        season: se.season,
        episode: se.episode,
        mediaType: (se.season != null || /\/(?:show|tv)\//i.test(tab.url)) ? 'tv' : 'movie',
      });
      renderWatchlist();
    } catch (err) {
      showWatchlistError((err && err.message) || 'Could not add this tab to the watchlist.');
    }
  });

  // ---------------------------------------------------------------------
  // Subtitles (talks to content/subtitles.js on the active Nepu tab via
  // chrome.tabs.sendMessage — see the SUB_* contract at the bottom of
  // content/subtitles.js)
  // ---------------------------------------------------------------------
  const subNotNepuEl = document.getElementById('subtitles-not-nepu');
  const subBodyEl = document.getElementById('subtitles-body');
  const subSubtabButtons = Array.from(document.querySelectorAll('.subtab-btn'));
  const subPanels = {
    search: document.getElementById('subpanel-search'),
    style: document.getElementById('subpanel-style'),
  };
  const subStatusEl = document.getElementById('sub-status');

  const subQueryInput = document.getElementById('sub-query');
  const subSeasonInput = document.getElementById('sub-season');
  const subEpisodeInput = document.getElementById('sub-episode');
  const subImdbInput = document.getElementById('sub-imdb');
  const subTmdbIdInput = document.getElementById('sub-tmdbid');
  const subLangSelect = document.getElementById('sub-lang');
  const subHiSelect = document.getElementById('sub-hi');
  const subRememberCheckbox = document.getElementById('sub-remember');
  const subSearchBtn = document.getElementById('sub-search-btn');
  const subTmdbSearchBtn = document.getElementById('sub-tmdb-search-btn');
  const subReloadLastBtn = document.getElementById('sub-reload-last-btn');
  const subTmdbListEl = document.getElementById('sub-tmdb-list');
  const subCandListEl = document.getElementById('sub-cand-list');
  const subTimingOffset = document.getElementById('sub-timing-offset');
  const subTimingOffsetPrecise = document.getElementById('sub-timing-offset-precise');
  const subTimingVal = document.getElementById('sub-timing-val');
  const subTimingPrecise = document.getElementById('sub-timing-precise');
  const subResetTimingBtn = document.getElementById('sub-reset-timing-btn');

  const subStyleBottomPx = document.getElementById('sub-style-bottompx');
  const subStyleBottomPxVal = document.getElementById('sub-style-bottompx-val');
  const subStyleHorizontal = document.getElementById('sub-style-horizontal');
  const subStyleHorizontalVal = document.getElementById('sub-style-horizontal-val');
  const subStyleSize = document.getElementById('sub-style-size');
  const subStyleSizeVal = document.getElementById('sub-style-size-val');
  const subStyleColor = document.getElementById('sub-style-color');
  const subStyleFont = document.getElementById('sub-style-font');
  const subStyleBg = document.getElementById('sub-style-bg');
  const subStyleOpacityTitle = document.getElementById('sub-style-opacity-title');
  const subStyleOpacity = document.getElementById('sub-style-opacity');
  const subStyleOpacityVal = document.getElementById('sub-style-opacity-val');
  const subStyleBlurWrap = document.getElementById('sub-style-blur-wrap');
  const subStyleBlur = document.getElementById('sub-style-blur');
  const subStyleBlurVal = document.getElementById('sub-style-blur-val');
  const subStyleDepth = document.getElementById('sub-style-depth');
  const subCcToggleBtn = document.getElementById('sub-cc-toggle-btn');
  const subResetStyleBtn = document.getElementById('sub-reset-style-btn');

  let subTabId = null;
  let selectedCandidateFileId = null;

  function switchSubtab(name) {
    subSubtabButtons.forEach((b) => b.classList.toggle('active', b.dataset.subtab === name));
    Object.keys(subPanels).forEach((k) => subPanels[k].classList.toggle('active', k === name));
  }
  subSubtabButtons.forEach((b) => b.addEventListener('click', () => switchSubtab(b.dataset.subtab)));

  function setSubStatus(msg, kind) {
    subStatusEl.textContent = msg || '';
    subStatusEl.dataset.kind = kind || 'info';
  }

  async function getActiveNepuTab() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.url) return null;
      if (!/^https?:\/\/([^/]*\.)?(nepu\.to|nepu\.is|nepu\.net)(\/|$)/i.test(tab.url)) return null;
      return tab;
    } catch (err) {
      return null;
    }
  }

  function sendSub(type, payload) {
    return new Promise((resolve) => {
      if (!subTabId) {
        resolve({ ok: false, error: 'Not connected to a Nepu tab.' });
        return;
      }
      chrome.tabs.sendMessage(subTabId, { type, payload }, (res) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(res || { ok: false, error: 'No response from the page.' });
      });
    });
  }

  function handleInjectResult(res) {
    if (!res) {
      setSubStatus('No response from the page.', 'error');
      return;
    }
    if (res.ok) {
      const cues = res.cueCount != null ? ` · ${res.cueCount} cues` : '';
      const rem = res.remaining != null ? ` · ${res.remaining} left today` : '';
      setSubStatus(`Captions on (${res.method}${cues})${rem}`, 'ok');
    } else if (res.reason === 'cross-origin-iframe') {
      setSubStatus(res.message || 'Player is inside a cross-origin iframe.', 'warn');
    } else {
      setSubStatus(res.error || res.message || 'Could not inject captions.', 'warn');
    }
  }

  function renderSubCandidates(list) {
    subCandListEl.innerHTML = '';
    if (!list || !list.length) {
      const empty = document.createElement('div');
      empty.className = 'sub-empty';
      empty.textContent = 'No results yet. Edit the title and search.';
      subCandListEl.appendChild(empty);
      return;
    }
    list.forEach((c) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sub-cand';
      btn.classList.toggle('selected', c.fileId === selectedCandidateFileId);
      const hi = c.hearingImpaired ? ' · HI' : '';
      const dl = c.downloadCount ? ` · \u2193${c.downloadCount}` : '';
      const se = c.seasonNumber != null && c.episodeNumber != null
        ? ` · S${c.seasonNumber} E${c.episodeNumber}`
        : '';
      btn.innerHTML = `
        <span class="sub-cand-check">&#10003;</span>
        <span class="sub-cand-top"><b>${escapeHtml(c.language || '?')}</b>${escapeHtml(hi)}${escapeHtml(dl)}${escapeHtml(se)}</span>
        <span class="sub-cand-mid">${escapeHtml(c.release || c.filename || c.movieName || 'Untitled')}</span>
        <span class="sub-cand-bot">${escapeHtml((c.parentTitle ? c.parentTitle + ' · ' : '') + (c.uploader || '—'))}</span>
      `;
      btn.addEventListener('click', async () => {
        setSubStatus(`Downloading "${c.release || c.filename || c.fileId}"…`, 'info');
        const res = await sendSub('SUB_DOWNLOAD_CANDIDATE', {
          fileId: c.fileId,
          query: subQueryInput.value.trim(),
        });
        if (res && res.ok) {
          selectedCandidateFileId = c.fileId;
          subCandListEl.querySelectorAll('.sub-cand.selected').forEach((el) => el.classList.remove('selected'));
          btn.classList.add('selected');
        }
        handleInjectResult(res);
      });
      subCandListEl.appendChild(btn);
    });
  }

  function renderSubTmdbResults(list) {
    subTmdbListEl.innerHTML = '';
    if (!list || !list.length) return;
    list.forEach((item) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sub-cand';
      const kind = item.mediaType === 'tv' ? 'TV' : 'Movie';
      const year = item.year ? ` · ${item.year}` : '';
      btn.innerHTML = `
        <span class="sub-cand-top"><b>${escapeHtml(kind)}</b>${escapeHtml(year)}</span>
        <span class="sub-cand-mid">${escapeHtml(item.title)}</span>
        <span class="sub-cand-bot">${escapeHtml((item.overview || '').slice(0, 100) || '—')}</span>
      `;
      btn.addEventListener('click', async () => {
        setSubStatus(`Resolving TMDB IDs for "${item.title}"…`, 'info');
        const seasonRaw = subSeasonInput.value.trim();
        const episodeRaw = subEpisodeInput.value.trim();
        const res = await sendSub('SUB_TMDB_PICK', {
          item,
          season: seasonRaw === '' ? null : Number(seasonRaw),
          episode: episodeRaw === '' ? null : Number(episodeRaw),
        });
        if (!res.ok) {
          setSubStatus(res.error || 'TMDB resolve failed', 'error');
          return;
        }
        subQueryInput.value = res.query || subQueryInput.value;
        subImdbInput.value = res.imdbId || '';
        subTmdbIdInput.value = res.tmdbId || '';
        if (res.season != null) subSeasonInput.value = res.season;
        if (res.episode != null) subEpisodeInput.value = res.episode;
        setSubStatus(`Matched via TMDB · ${res.query}. Search OpenSubtitles when ready.`, 'ok');
      });
      subTmdbListEl.appendChild(btn);
    });
  }

  subSearchBtn.addEventListener('click', async () => {
    setSubStatus('Searching OpenSubtitles…', 'info');
    subSearchBtn.disabled = true;
    try {
      const seasonRaw = subSeasonInput.value.trim();
      const episodeRaw = subEpisodeInput.value.trim();
      const res = await sendSub('SUB_SEARCH', {
        query: subQueryInput.value.trim(),
        season: seasonRaw === '' ? null : Number(seasonRaw),
        episode: episodeRaw === '' ? null : Number(episodeRaw),
        imdbId: subImdbInput.value.trim(),
        tmdbId: subTmdbIdInput.value.trim(),
        lang: subLangSelect.value,
        hi: subHiSelect.value,
        remember: subRememberCheckbox.checked,
      });
      if (!res.ok) {
        setSubStatus(res.error || 'Search failed', res.needsSettings ? 'warn' : 'error');
        return;
      }
      renderSubCandidates(res.candidates);
      setSubStatus(
        res.candidates.length
          ? `Found ${res.candidates.length} subtitle(s). Click one to load.`
          : 'No results — try TMDB match, or edit title / S/E / IMDb.',
        res.candidates.length ? 'ok' : 'warn'
      );
    } finally {
      subSearchBtn.disabled = false;
    }
  });

  subTmdbSearchBtn.addEventListener('click', async () => {
    setSubStatus('Searching TMDB…', 'info');
    subTmdbSearchBtn.disabled = true;
    try {
      const res = await sendSub('SUB_TMDB_SEARCH', { query: subQueryInput.value.trim() });
      if (!res.ok) {
        setSubStatus(res.error || 'TMDB search failed', 'error');
        return;
      }
      renderSubTmdbResults(res.results);
      setSubStatus(
        res.results.length
          ? `TMDB: ${res.results.length} result(s). Pick one to fill IDs.`
          : 'No TMDB results — try another title.',
        res.results.length ? 'ok' : 'warn'
      );
    } finally {
      subTmdbSearchBtn.disabled = false;
    }
  });

  subReloadLastBtn.addEventListener('click', async () => {
    setSubStatus('Re-downloading last subtitle…', 'info');
    const res = await sendSub('SUB_RELOAD_LAST');
    handleInjectResult(res);
  });

  subHiSelect.addEventListener('change', async () => {
    const res = await sendSub('SUB_SET_HI_FILTER', { hi: subHiSelect.value });
    if (res.ok) renderSubCandidates(res.candidates);
  });

  function updateTimingDisplay(offset, precise) {
    const n = Number(offset) || 0;
    subTimingPrecise.checked = __omp_shell("!precise;")
    subTimingOffset.hidden = __omp_shell("!precise;")
    subTimingOffsetPrecise.hidden = __omp_shell("precise;")
    if (precise) {
      subTimingOffsetPrecise.value = String(n);
    } else {
      subTimingOffset.value = String(Math.max(-10, Math.min(10, n)));
    }
    const sign = n > 0 ? '+' : '';
    subTimingVal.textContent = `${sign}${n.toFixed(2)}s`;
  }

  subTimingOffset.addEventListener('input', async () => {
    const res = await sendSub('SUB_SET_TIMING', { offset: subTimingOffset.value, precise: false });
    if (res.ok) updateTimingDisplay(res.offset, res.precise);
  });
  subTimingOffsetPrecise.addEventListener('change', async () => {
    const res = await sendSub('SUB_SET_TIMING', { offset: subTimingOffsetPrecise.value, precise: true });
    if (res.ok) updateTimingDisplay(res.offset, res.precise);
  });
  subTimingPrecise.addEventListener('change', async () => {
    const res = await sendSub('SUB_SET_TIMING_PRECISE', { on: subTimingPrecise.checked });
    if (res.ok) updateTimingDisplay(res.offset, res.precise);
  });
  subResetTimingBtn.addEventListener('click', async () => {
    const res = await sendSub('SUB_RESET_TIMING');
    if (res.ok) updateTimingDisplay(res.offset, res.precise);
    setSubStatus('Timing offset reset to 0s.', 'ok');
  });

  function syncSubSoftBlurControls() {
    const soft = subStyleBg.value === 'soft';
    subStyleOpacityTitle.textContent = soft ? 'Blur hardness' : 'Background opacity';
    subStyleBlurWrap.hidden = __omp_shell("soft;")
  }

  function writeStyleForm(style) {
    const s = style || {};
    const bottomPx = Math.round(s.bottomPx ?? 72);
    const horizontal = Math.round(s.horizontal ?? 50);
    const fontSize = Math.round(s.fontSize ?? 24);
    const bgOpacity = Math.round(s.bgOpacity ?? 72);
    const blurRadius = Math.round(s.blurRadius ?? 16);
    subStyleBottomPx.value = String(bottomPx);
    subStyleBottomPxVal.textContent = `${bottomPx}px`;
    subStyleHorizontal.value = String(horizontal);
    subStyleHorizontalVal.textContent = `${horizontal}%`;
    subStyleSize.value = String(fontSize);
    subStyleSizeVal.textContent = `${fontSize}px`;
    subStyleColor.value = s.color || '#ffffff';
    const fontFamily = s.fontFamily || "Arial, Helvetica, sans-serif";
    subStyleFont.value = fontFamily;
    if (subStyleFont.value !== fontFamily) {
      const opt = document.createElement('option');
      opt.value = fontFamily;
      opt.textContent = fontFamily.split(',')[0];
      subStyleFont.appendChild(opt);
      subStyleFont.value = fontFamily;
    }
    subStyleBg.value = s.background === 'blur' ? 'plate' : (s.background || 'box');
    subStyleOpacity.value = String(bgOpacity);
    subStyleOpacityVal.textContent = `${bgOpacity}%`;
    subStyleBlur.value = String(blurRadius);
    subStyleBlurVal.textContent = `${blurRadius}px`;
    subStyleDepth.value = s.depth || 'outline';
    syncSubSoftBlurControls();
  }

  subStyleBottomPx.addEventListener('input', async () => {
    subStyleBottomPxVal.textContent = `${subStyleBottomPx.value}px`;
    await sendSub('SUB_SET_STYLE', { bottomPx: Number(subStyleBottomPx.value) });
  });
  subStyleHorizontal.addEventListener('input', async () => {
    subStyleHorizontalVal.textContent = `${subStyleHorizontal.value}%`;
    await sendSub('SUB_SET_STYLE', { horizontal: Number(subStyleHorizontal.value) });
  });
  subStyleSize.addEventListener('input', async () => {
    subStyleSizeVal.textContent = `${subStyleSize.value}px`;
    await sendSub('SUB_SET_STYLE', { fontSize: Number(subStyleSize.value) });
  });
  subStyleColor.addEventListener('input', () => {
    sendSub('SUB_SET_STYLE', { color: subStyleColor.value });
  });
  subStyleFont.addEventListener('change', () => {
    sendSub('SUB_SET_STYLE', { fontFamily: subStyleFont.value });
  });
  subStyleBg.addEventListener('change', () => {
    syncSubSoftBlurControls();
    sendSub('SUB_SET_STYLE', { background: subStyleBg.value });
  });
  subStyleOpacity.addEventListener('input', async () => {
    subStyleOpacityVal.textContent = `${subStyleOpacity.value}%`;
    await sendSub('SUB_SET_STYLE', { bgOpacity: Number(subStyleOpacity.value) });
  });
  subStyleBlur.addEventListener('input', async () => {
    subStyleBlurVal.textContent = `${subStyleBlur.value}px`;
    await sendSub('SUB_SET_STYLE', { blurRadius: Number(subStyleBlur.value) });
  });
  subStyleDepth.addEventListener('change', () => {
    sendSub('SUB_SET_STYLE', { depth: subStyleDepth.value });
  });
  subResetStyleBtn.addEventListener('click', async () => {
    const res = await sendSub('SUB_RESET_STYLE');
    if (res.ok) writeStyleForm(res.style);
    setSubStatus('Caption style reset to defaults.', 'ok');
  });

  function updateCcButton(hidden) {
    subCcToggleBtn.textContent = hidden ? 'CC off' : 'CC on';
    subCcToggleBtn.classList.toggle('active', !hidden);
  }
  subCcToggleBtn.addEventListener('click', async () => {
    const res = await sendSub('SUB_TOGGLE_CAPTIONS');
    if (res.ok) updateCcButton(res.hidden);
  });

  async function refreshSubState() {
    const res = await sendSub('SUB_GET_STATE');
    if (!res || !res.ok) {
      setSubStatus((res && res.error) || 'Could not reach the page. Reload it and try again.', 'error');
      return;
    }
    const identified = res.identified || {};
    subQueryInput.value = identified.query || identified.title || '';
    subImdbInput.value = identified.imdbId || '';
    subSeasonInput.value = identified.season != null ? identified.season : '';
    subEpisodeInput.value = identified.episode != null ? identified.episode : '';
    subLangSelect.value = res.lang || 'en';
    subHiSelect.value = res.hiFilter || 'all';
    subRememberCheckbox.checked = res.remember !== false;
    selectedCandidateFileId = (res.lastPick && res.lastPick.fileId) || null;
    renderSubCandidates(res.candidates || []);
    renderSubTmdbResults(res.tmdbResults || []);
    writeStyleForm(res.style);
    updateTimingDisplay(res.timing.offset, res.timing.precise);
    updateCcButton(res.captionsHidden);

    if (!res.hasApiKey) {
      setSubStatus("Set your OpenSubtitles API key in Settings to search.", 'warn');
    } else if (res.detect && res.detect.blocked) {
      setSubStatus('Player appears to be inside a cross-origin iframe — captions may not inject.', 'warn');
    } else {
      const se = identified.season != null && identified.episode != null
        ? ` · S${identified.season} E${identified.episode}`
        : '';
      setSubStatus(`Ready · title from ${identified.source}${se}`, 'info');
    }
  }

  async function initSubtitlesTab() {
    const tab = await getActiveNepuTab();
    if (!tab) {
      subTabId = null;
      subNotNepuEl.hidden = false;
      subBodyEl.hidden = true;
      return;
    }
    subTabId = tab.id;
    subNotNepuEl.hidden = true;
    subBodyEl.hidden = false;
    await refreshSubState();
  }


  // ---------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------
  const trackToggle = document.getElementById('track-toggle');
  const resumeToggle = document.getElementById('resume-toggle');
  const minDurationInput = document.getElementById('min-duration-input');
  const completedRange = document.getElementById('completed-range');
  const completedValueEl = document.getElementById('completed-value');
  const autoApplyToggle = document.getElementById('autoapply-toggle');
  const useTimeToggle = document.getElementById('usetime-toggle');
  const modernUiToggle = document.getElementById('modernui-toggle');
  const dropboxAutoSyncToggle = document.getElementById('dropbox-autosync-toggle');
  const dropboxSyncNowBtn = document.getElementById('dropbox-sync-now-btn');
  const dropboxStatusEl = document.getElementById('dropbox-status');
  const openOptionsBtn = document.getElementById('open-options-btn');

  async function initSettings() {
    const settings = state.settings || await NVT.getSettings();
    state.settings = settings;

    trackToggle.checked = !!settings.trackingEnabled;
    resumeToggle.checked = !!settings.resumeEnabled;
    autoApplyToggle.checked = !!settings.autoApplyCaptions;
    useTimeToggle.checked = !!settings.useTimeProgress;
    modernUiToggle.checked = settings.nepuModernUi !== false;
    dropboxAutoSyncToggle.checked = settings.dropboxAutoSync !== false;
    minDurationInput.value = settings.minDurationSeconds;
    completedRange.value = Math.round((settings.completedThreshold || 0) * 100);
    completedValueEl.textContent = completedRange.value;

    trackToggle.addEventListener('change', async () => {
      state.settings = await NVT.setSettings({ trackingEnabled: trackToggle.checked });
    });
    resumeToggle.addEventListener('change', async () => {
      state.settings = await NVT.setSettings({ resumeEnabled: resumeToggle.checked });
    });
    autoApplyToggle.addEventListener('change', async () => {
      state.settings = await NVT.setSettings({ autoApplyCaptions: autoApplyToggle.checked });
    useTimeToggle.addEventListener('change', async () => {
      state.settings = await NVT.setSettings({ useTimeProgress: useTimeToggle.checked });
      renderContinue();
    });
    modernUiToggle.addEventListener('change', async () => {
      state.settings = await NVT.setSettings({ nepuModernUi: modernUiToggle.checked });
    });
      state.settings = await NVT.setSettings({ useTimeProgress: useTimeToggle.checked });
      renderContinue();
    });
    dropboxAutoSyncToggle.addEventListener('change', async () => {
      state.settings = await NVT.setSettings({ dropboxAutoSync: dropboxAutoSyncToggle.checked });
    });
    minDurationInput.addEventListener('change', async () => {
      const v = Math.max(0, Math.round(Number(minDurationInput.value) || 0));
      minDurationInput.value = v;
      state.settings = await NVT.setSettings({ minDurationSeconds: v });
    });
    completedRange.addEventListener('input', () => {
      completedValueEl.textContent = completedRange.value;
    });
    completedRange.addEventListener('change', async () => {
      const v = Number(completedRange.value) / 100;
      state.settings = await NVT.setSettings({ completedThreshold: v });
    });
    openOptionsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());
  }

  function renderDropboxStatus(sync, connected) {
    const bits = [];
    if (!connected) {
      bits.push('Not connected — set up Dropbox in the extension Options page');
    } else if (sync.syncing) {
      bits.push('Syncing…');
    } else if (sync.lastSyncAt) {
      bits.push(`Synced ${relativeTime(sync.lastSyncAt)}`);
    } else {
      bits.push('Not synced yet');
    }
    if (sync.lastSyncOk === false && sync.lastSyncError) bits.push(sync.lastSyncError);
    dropboxStatusEl.textContent = bits.join(' · ');
    dropboxStatusEl.dataset.kind = sync.lastSyncOk === false ? 'error' : connected ? 'ok' : 'warn';
  }

  async function refreshDropboxStatus() {
    const [auth, sync] = await Promise.all([NVT.getDropboxAuth(), NVT.getSyncStatus()]);
    const connected = !!auth.refreshToken;
    dropboxSyncNowBtn.disabled = !connected;
    renderDropboxStatus(sync, connected);
  }

  dropboxSyncNowBtn.addEventListener('click', async () => {
    dropboxSyncNowBtn.disabled = true;
    dropboxStatusEl.textContent = 'Syncing…';
    dropboxStatusEl.dataset.kind = 'info';
    try {
      await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'DROPBOX_SYNC', payload: { force: true } }, resolve);
      });
    } finally {
      await refreshDropboxStatus();
    }
  });

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------

  // The popup only reads storage once on open — without this, progress
  // saved by a video playing in another tab (every pause / 5s) wouldn't
  // show up until you closed and reopened the popup.
  let historyRefreshTimer = null;
  let watchlistRefreshTimer = null;
  let dropboxStatusRefreshTimer = null;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const keys = Object.keys(changes);
    if (keys.some((k) => k.startsWith(NVT.HIST_PREFIX))) {
      clearTimeout(historyRefreshTimer);
      historyRefreshTimer = setTimeout(renderContinue, 200);
    }
    if (keys.some((k) => k.startsWith(NVT.WL_PREFIX))) {
      clearTimeout(watchlistRefreshTimer);
      watchlistRefreshTimer = setTimeout(renderWatchlist, 200);
    }
    if (keys.some((k) => k === NVT.SYNC_STATUS_KEY || k.startsWith('dropbox:'))) {
      clearTimeout(dropboxStatusRefreshTimer);
      dropboxStatusRefreshTimer = setTimeout(refreshDropboxStatus, 200);
    }
  });

  async function boot() {
    continueViewMode = await getViewMode('continue');
    continueViewToggle.setActive(continueViewMode);
    watchlistViewMode = await getViewMode('watchlist');
    watchlistViewToggle.setActive(watchlistViewMode);
    await Promise.all([renderContinue(), renderWatchlist(), initSettings(), refreshDropboxStatus()]);
  }

  boot().catch((err) => {
    console.error('[Nepu Watch Tracker] popup init failed:', err);
  });
})();
