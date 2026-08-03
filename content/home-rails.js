/**
 * Injects homepage rails into Nepu (above the first site ".app-heading" row):
 *   1. Continue Watching  (local history)
 *   2. Watchlist          (local watchlist)
 *   3. Discovery rails    (TMDB cache — multi-row layout: personalized
 *                          "Because you…", Now Playing, Trending, Popular TV,
 *                          Anime, genres)
 *
 * Read-only view of NVT store + recommendations cache; editing is in the
 * popup/options. Nothing renders if every list is empty.
 */
(function () {
  'use strict';

  // Content scripts run with all_frames:true so the tracker can see iframe
  // players; rails only belong on the top-level homepage document.
  if (window !== window.top) return;

  const WRAPPER_ID = 'nvt-home-rails';
  let lastSignature = null;

  function injectStyle() {
    if (document.getElementById('nvt-home-rails-style')) return;
    const style = document.createElement('style');
    style.id = 'nvt-home-rails-style';
    style.textContent = `
      #${WRAPPER_ID} { margin-bottom: 12px; }
      .nvt-rail-section { margin-bottom: 22px; }
      .nvt-rail-section .app-heading { margin-bottom: 12px; }
      .nvt-rail {
        display: flex;
        gap: 14px;
        overflow-x: auto;
        padding: 4px 2px 14px;
        scrollbar-width: none;
        scroll-snap-type: x proximity;
        -webkit-overflow-scrolling: touch;
      }
      .nvt-rail::-webkit-scrollbar {
        display: none;
      }
      .nvt-rail-card {
        flex: 0 0 auto;
        width: 148px;
        color: inherit;
        text-decoration: none;
        display: block;
        scroll-snap-align: start;
        transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      }
      .nvt-rail-card:hover {
        transform: translateY(-4px);
      }
      .nvt-rail-card-loading {
        opacity: 0.55;
        pointer-events: none;
      }
      .nvt-rail-card-loading .nvt-rail-thumb::after {
        content: '';
        position: absolute;
        inset: 0;
        background: rgba(11, 15, 25, 0.45);
        z-index: 3;
      }
      .nvt-rail-thumb {
        position: relative;
        width: 148px;
        height: 222px;
        border-radius: 10px;
        overflow: hidden;
        background: #1f2937;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
        transition: box-shadow 0.2s ease;
      }
      .nvt-rail-card:hover .nvt-rail-thumb {
        box-shadow: 0 12px 28px rgba(0, 0, 0, 0.55);
      }
      .nvt-rail-thumb img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
        transition: transform 0.25s ease;
      }
      .nvt-rail-card:hover .nvt-rail-thumb img {
        transform: scale(1.05);
      }
      .nvt-rail-fallback {
        font-size: 30px;
      }
      .nvt-rail-progress {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        height: 4px;
        background: rgba(255, 255, 255, 0.25);
      }
      .nvt-rail-progress-fill {
        height: 100%;
        background: #5b8cff;
      }
      .nvt-rail-badge {
        position: absolute;
        top: 6px;
        left: 6px;
        background: rgba(0, 0, 0, 0.6);
        color: #fff;
        font-size: 10px;
        font-weight: 700;
        padding: 2px 6px;
        border-radius: 4px;
        z-index: 2;
      }
      .nvt-rail-badge.nvt-rail-new-release {
        background: #10b981 !important;
        color: #042f2e !important;
        font-weight: 700;
        box-shadow: 0 2px 6px rgba(16, 185, 129, 0.4);
        border: none;
        cursor: pointer;
        font-family: inherit;
        pointer-events: auto;
      }
      .nvt-rail-badge.nvt-rail-new-release:hover {
        background: #34d399 !important;
        filter: brightness(1.05);
      }
      .nvt-rail-badge.nvt-rail-complete {
        top: 6px;
        left: auto;
        right: 6px;
        background: rgba(37, 99, 235, 0.92) !important;
        color: #eff6ff !important;
        font-weight: 700;
        box-shadow: 0 2px 6px rgba(37, 99, 235, 0.35);
        border: none;
      }
      .nvt-rail-badge.nvt-rail-series-complete {
        top: 6px;
        left: auto;
        right: 6px;
        background: rgba(124, 58, 237, 0.92) !important;
        color: #f5f3ff !important;
        font-weight: 700;
        box-shadow: 0 2px 6px rgba(124, 58, 237, 0.35);
        border: none;
      }
      .nvt-rail-badge.nvt-rail-finished {
        top: 6px;
        left: auto;
        right: 6px;
        background: rgba(107, 114, 128, 0.92) !important;
        color: #f9fafb !important;
        font-weight: 700;
        border: none;
      }
      .nvt-rail-remove {
        position: absolute;
        top: 6px;
        right: 6px;
        z-index: 4;
        width: 24px;
        height: 24px;
        border: none;
        border-radius: 50%;
        background: rgba(0, 0, 0, 0.65);
        color: #fff;
        font-size: 14px;
        line-height: 1;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        opacity: 0;
        transition: opacity 0.15s ease, background 0.15s ease;
        padding: 0;
        font-family: inherit;
      }
      .nvt-rail-card:hover .nvt-rail-remove,
      .nvt-rail-remove:focus {
        opacity: 1;
      }
      .nvt-rail-remove:hover {
        background: #ef4444;
      }
      .nvt-rail-badge.nvt-rail-rating {
        top: auto;
        left: auto;
        right: 6px;
        bottom: 6px;
        background: rgba(11, 15, 25, 0.82) !important;
        color: #fbbf24 !important;
        font-weight: 700;
        border: 1px solid rgba(251, 191, 36, 0.4);
      }
      .nvt-rail-badge.nvt-rail-kind {
        top: 6px;
        left: 6px;
        right: auto;
        bottom: auto;
        background: rgba(37, 99, 235, 0.85) !important;
        color: #fff !important;
        border: none;
        text-transform: uppercase;
        letter-spacing: 0.03em;
        font-size: 9px;
      }
      .nvt-rail-title {
        font-size: 12.5px;
        margin-top: 8px;
        line-height: 1.3;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        word-break: break-word;
        font-weight: 600;
      }
      .nvt-rail-meta {
        font-size: 11px;
        margin-top: 2px;
        opacity: 0.65;
      }

      /* Tablet: slightly denser rails */
      @media (max-width: 900px) {
        .nvt-rail-section { margin-bottom: 18px; }
        .nvt-rail {
          gap: 12px;
          padding: 2px 0 12px;
        }
        .nvt-rail-card { width: 132px; }
        .nvt-rail-thumb {
          width: 132px;
          height: 198px;
          border-radius: 8px;
        }
        .nvt-rail-title { font-size: 12px; margin-top: 6px; }
      }

      /* Phone: smaller posters, roomier tap targets */
      @media (max-width: 640px) {
        .nvt-rail-section { margin-bottom: 16px; }
        .nvt-rail-section .app-heading { margin-bottom: 8px; }
        .nvt-rail {
          gap: 10px;
          padding: 2px 0 10px;
        }
        .nvt-rail-card { width: 112px; }
        .nvt-rail-thumb {
          width: 112px;
          height: 168px;
          border-radius: 8px;
          box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
        }
        .nvt-rail-fallback { font-size: 24px; }
        .nvt-rail-title {
          font-size: 11.5px;
          margin-top: 6px;
        }
        .nvt-rail-meta { font-size: 10px; }
        .nvt-rail-remove {
          width: 28px;
          height: 28px;
          font-size: 15px;
          opacity: 0.92;
          background: rgba(0, 0, 0, 0.72);
        }
        .nvt-rail-badge {
          font-size: 9px;
          padding: 2px 5px;
        }
        .nvt-rail-badge.nvt-rail-kind { font-size: 8px; }
      }

      /* Touch: no hover-only chrome; keep remove visible */
      @media (hover: none) {
        .nvt-rail-card:hover { transform: none; }
        .nvt-rail-card:hover .nvt-rail-thumb img { transform: none; }
        .nvt-rail-card:hover .nvt-rail-thumb {
          box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
        }
        .nvt-rail-remove { opacity: 0.9; }
        .nvt-rail-remove:active { background: #ef4444; }
      }
    `;
    document.head.appendChild(style);
  }

  /** Only the actual homepage — not show/movie/episode detail pages, which
   * have their own ".app-heading" rows (e.g. "Episodes", "More Like This"). */
  function isHomePage() {
    return location.pathname === '/' || location.pathname === '';
  }

  /** First top-level ".app-section" whose heading isn't part of our own
   * wrapper — anchoring on the section (not the bare heading) means our
   * rail becomes its own sibling section instead of nesting inside the
   * first "Latest ..." section (real nepu.is DOM: .app-heading is a
   * direct child of .app-section, alongside the row/grid). */
  function findAnchor() {
    if (!isHomePage()) return null;
    const headings = document.querySelectorAll('.app-heading');
    for (const h of headings) {
      if (h.closest('#' + WRAPPER_ID)) continue;
      return h.closest('.app-section') || h;
    }
    return null;
  }

  function fallbackEl() {
    const div = document.createElement('div');
    div.className = 'nvt-rail-fallback';
    div.textContent = '\u{1F3AC}';
    return div;
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

  function seLabel(item) {
    return item.season != null && item.episode != null ? `S${item.season} E${item.episode}` : '';
  }

  /** TMDB discovery cards have no nepu slug. Resolve title → first catalog
   * hit (ajax/search page scrape), cache it, navigate there; fall back to
   * the site search form / /search?q= only if resolve fails. */
  const URL_CACHE_KEY = 'nvt_nepu_url_cache';
  const urlResolveInflight = new Map();

  function normalizeTitle(t) {
    return String(t || '')
      .toLowerCase()
      .replace(/&amp;/g, 'and')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function cacheKeyFor(item) {
    return `${item.mediaType === 'tv' ? 'tv' : item.mediaType === 'movie' ? 'movie' : 'any'}:${normalizeTitle(item.title)}`;
  }

  async function readUrlCache() {
    try {
      const res = await chrome.storage.local.get(URL_CACHE_KEY);
      return res[URL_CACHE_KEY] && typeof res[URL_CACHE_KEY] === 'object' ? res[URL_CACHE_KEY] : {};
    } catch (_) {
      return {};
    }
  }

  async function writeUrlCacheEntry(key, url) {
    try {
      const cache = await readUrlCache();
      cache[key] = { url, at: Date.now() };
      // Cap size so local storage doesn't grow forever.
      const keys = Object.keys(cache);
      if (keys.length > 200) {
        keys
          .sort((a, b) => (cache[a].at || 0) - (cache[b].at || 0))
          .slice(0, keys.length - 200)
          .forEach((k) => delete cache[k]);
      }
      await chrome.storage.local.set({ [URL_CACHE_KEY]: cache });
    } catch (_) {
      /* ignore */
    }
  }

  function titleMatchScore(queryNorm, candidateTitle, mediaType, href) {
    const cand = normalizeTitle(candidateTitle);
    if (!cand || !queryNorm) return 0;
    let score = 0;
    if (cand === queryNorm) score += 100;
    else if (cand.startsWith(queryNorm) || queryNorm.startsWith(cand)) score += 70;
    else if (cand.includes(queryNorm) || queryNorm.includes(cand)) score += 40;
    else return 0;

    const path = String(href || '');
    if (mediaType === 'tv' && /\/(?:show|tv)\//i.test(path)) score += 25;
    if (mediaType === 'movie' && /\/(?:movie|film|watch)\//i.test(path) && !/\/(?:show|tv)\//i.test(path)) score += 25;
    // Prefer series root over a random deep episode link.
    if (/\/season\/\d+\/episode\//i.test(path)) score -= 15;
    return score;
  }

  function collectLinksFromHtml(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const out = [];
    const nodes = doc.querySelectorAll(
      'a.list-media[href], a.list-movie[href], .list-movie a[href], .typeahead__list a[href], a[href*="/show/"], a[href*="/tv/"], a[href*="/movie/"], a[href*="/film/"]'
    );
    nodes.forEach((a) => {
      const href = a.getAttribute('href') || '';
      if (!href || href === '#' || href.startsWith('javascript:')) return;
      let title =
        a.getAttribute('title') ||
        (a.querySelector('.list-title, .caption, .title, .name') &&
          a.querySelector('.list-title, .caption, .title, .name').textContent) ||
        a.textContent ||
        '';
      title = String(title).replace(/\s+/g, ' ').trim();
      out.push({ href, title });
    });
    return out;
  }

  function collectLinksFromJson(data) {
    const out = [];
    const stack = [data];
    while (stack.length) {
      const cur = stack.pop();
      if (!cur) continue;
      if (Array.isArray(cur)) {
        cur.forEach((x) => stack.push(x));
        continue;
      }
      if (typeof cur !== 'object') continue;
      const href = cur.href || cur.url || cur.link || cur.path || '';
      const title = cur.name || cur.title || cur.caption || cur.text || '';
      if (href && title) out.push({ href: String(href), title: String(title) });
      Object.keys(cur).forEach((k) => {
        if (k === 'href' || k === 'url' || k === 'link') return;
        if (cur[k] && typeof cur[k] === 'object') stack.push(cur[k]);
      });
    }
    return out;
  }

  function absolutize(href) {
    try {
      return new URL(href, location.origin).href;
    } catch (_) {
      return null;
    }
  }

  function pickBestLink(links, title, mediaType) {
    const q = normalizeTitle(title);
    let best = null;
    let bestScore = 0;
    for (const link of links) {
      const abs = absolutize(link.href);
      if (!abs || abs.indexOf(location.origin) !== 0) continue;
      // Stay on catalog pages, not search itself.
      if (/\/search/i.test(abs) && !/\/(?:show|tv|movie|film)\//i.test(abs)) continue;
      const score = titleMatchScore(q, link.title, mediaType, abs);
      if (score > bestScore) {
        bestScore = score;
        best = abs;
      }
    }
    return bestScore >= 40 ? best : null;
  }

  function searchEndpoints(query) {
    const q = encodeURIComponent(query);
    const endpoints = [];
    const input =
      document.getElementById('search-input') ||
      document.querySelector('.app-search input, .typeahead__field input, input[name="q"]');
    if (input) {
      ['data-url', 'data-search', 'data-live-url', 'data-action'].forEach((attr) => {
        const v = input.getAttribute(attr);
        if (v) endpoints.push(v.includes('q=') || v.includes('{query}') ? v.replace('{query}', q) : `${v}${v.includes('?') ? '&' : '?'}q=${q}`);
      });
      if (input.form && input.form.action) {
        try {
          const u = new URL(input.form.action, location.origin);
          u.searchParams.set(input.name || 'q', query);
          endpoints.push(u.pathname + u.search);
        } catch (_) {
          /* ignore */
        }
      }
    }
    // Common endpoints for this stream-theme family + generic search page.
    [
      `/ajax/search?q=${q}`,
      `/search?q=${q}`,
      `/search/${q}`,
      `/filter?q=${q}`,
      `/ajax/filter?q=${q}`,
    ].forEach((u) => endpoints.push(u));
    // de-dupe
    return [...new Set(endpoints)];
  }

  async function resolveNepuUrl(title, mediaType) {
    const endpoints = searchEndpoints(title);
    for (const path of endpoints) {
      try {
        const resp = await fetch(path, {
          credentials: 'same-origin',
          headers: {
            Accept: 'application/json, text/html, */*',
            'X-Requested-With': 'XMLHttpRequest',
          },
        });
        if (!resp.ok) continue;
        const ct = (resp.headers.get('content-type') || '').toLowerCase();
        const text = await resp.text();
        let links = [];
        if (ct.includes('json') || (text.trim().startsWith('{') || text.trim().startsWith('['))) {
          try {
            links = collectLinksFromJson(JSON.parse(text));
          } catch (_) {
            links = collectLinksFromHtml(text);
          }
        } else {
          links = collectLinksFromHtml(text);
        }
        const best = pickBestLink(links, title, mediaType);
        if (best) return best;
      } catch (err) {
        console.debug('[Nepu Home Rails] resolve try failed', path, err);
      }
    }
    return null;
  }

  function fallbackSearchNavigate(title) {
    try {
      const input =
        document.getElementById('search-input') ||
        document.querySelector('.app-search input, .typeahead__field input, input[name="q"]');
      const form =
        (input && input.form) ||
        document.getElementById('navbarToggler') ||
        document.querySelector('form.app-search, .app-search form, form[action*="search"]');
      if (input && form) {
        input.value = title;
        if (typeof form.requestSubmit === 'function') form.requestSubmit();
        else form.submit();
        return true;
      }
    } catch (err) {
      console.debug('[Nepu Home Rails] search submit failed', err);
    }
    try {
      location.href = `${location.origin}/search?q=${encodeURIComponent(title)}`;
      return true;
    } catch (_) {
      return false;
    }
  }

  async function openRecommendItem(item) {
    const title = (item && item.title) || '';
    if (!title) return;
    const key = cacheKeyFor(item);

    if (urlResolveInflight.has(key)) {
      await urlResolveInflight.get(key);
      return;
    }

    const work = (async () => {
      try {
        const cache = await readUrlCache();
        const hit = cache[key];
        // Cache hits for 30 days.
        if (hit && hit.url && Date.now() - (hit.at || 0) < 30 * 24 * 60 * 60 * 1000) {
          location.href = hit.url;
          return;
        }
        const resolved = await resolveNepuUrl(title, item.mediaType);
        if (resolved) {
          await writeUrlCacheEntry(key, resolved);
          location.href = resolved;
          return;
        }
        fallbackSearchNavigate(title);
      } catch (err) {
        console.debug('[Nepu Home Rails] openRecommend failed', err);
        fallbackSearchNavigate(title);
      }
    })();

    urlResolveInflight.set(key, work);
    try {
      await work;
    } finally {
      urlResolveInflight.delete(key);
    }
  }

  function progressText(item, useTime) {
    // Episode progress only — don’t say "Finished" (reads like the whole show).
    if (item && item.completed) return '100%';
    if (useTime) return `${formatClock(item.currentTime)} / ${formatClock(item.duration)}`;
    const pct = Math.max(0, Math.min(100, Math.round((item.progress || 0) * 100)));
    return `${pct}%`;
  }

  function buildCard(item, mode, useTime) {
    const a = document.createElement('a');
    a.className = 'nvt-rail-card';
    if (mode === 'recommend') {
      a.href = '#';
      a.setAttribute('title', `Open “${item.title || ''}” on Nepu`);
      a.addEventListener('click', (e) => {
        e.preventDefault();
        a.classList.add('nvt-rail-card-loading');
        openRecommendItem(item).finally(() => {
          a.classList.remove('nvt-rail-card-loading');
        });
      });
    } else {
      a.href = item.url;
    }

    const thumb = document.createElement('div');
    thumb.className = 'nvt-rail-thumb';

    if (item.poster) {
      const img = document.createElement('img');
      img.src = item.poster;
      img.alt = '';
      img.addEventListener('error', () => {
        img.remove();
        thumb.appendChild(fallbackEl());
      });
      thumb.appendChild(img);
    } else {
      thumb.appendChild(fallbackEl());
    }

    if (mode === 'recommend') {
      if (item.mediaType === 'tv' || item.mediaType === 'movie') {
        const kind = document.createElement('div');
        kind.className = 'nvt-rail-badge nvt-rail-kind';
        kind.textContent = item.mediaType === 'tv' ? 'TV' : 'Movie';
        thumb.appendChild(kind);
      }
      if (item.rating != null) {
        const badge = document.createElement('div');
        badge.className = 'nvt-rail-badge nvt-rail-rating';
        badge.textContent = `★ ${item.rating}`;
        thumb.appendChild(badge);
      }
    } else if (mode === 'watchlist') {
      const progressLabel = NVT.watchlistProgressLabel(item);
      const hasNew =
        !progressLabel &&
        item.hasNewRelease &&
        item.latestSeason != null &&
        item.latestEpisode != null;
      if (hasNew) {
        const badge = document.createElement('button');
        badge.type = 'button';
        badge.className = 'nvt-rail-badge nvt-rail-new-release nvt-rail-clear-new';
        badge.textContent = `NEW S${item.latestSeason} E${item.latestEpisode}`;
        badge.title = 'Clear NEW badge (mark caught up)';
        badge.addEventListener('click', async (e) => {
          e.preventDefault();
          e.stopPropagation();
          try {
            await NVT.clearNewReleaseBadge(item.id);
            scheduleRender(50);
          } catch (err) {
            console.debug('[Nepu Home Rails] clear NEW failed', err);
          }
        });
        thumb.appendChild(badge);
      } else {
        const se = seLabel(item);
        if (se) {
          const badge = document.createElement('div');
          badge.className = 'nvt-rail-badge';
          badge.textContent = se;
          thumb.appendChild(badge);
        }
        if (progressLabel) {
          const done = document.createElement('div');
          done.className =
            'nvt-rail-badge ' +
            (progressLabel === 'Finished' ? 'nvt-rail-series-complete' : 'nvt-rail-complete');
          done.textContent = progressLabel;
          done.title =
            progressLabel === 'Finished'
              ? 'No more episodes left — show is done for you'
              : 'Caught up with all aired episodes (more may come later)';
          thumb.appendChild(done);
        }
      }
    } else {
      const se = seLabel(item);
      if (se) {
        const badge = document.createElement('div');
        badge.className = 'nvt-rail-badge';
        badge.textContent = se;
        thumb.appendChild(badge);
      }
    }

    if (mode === 'continue') {
      const pct = item.completed
        ? 100
        : Math.max(0, Math.min(100, Math.round((item.progress || 0) * 100)));
      const track = document.createElement('div');
      track.className = 'nvt-rail-progress';
      const fill = document.createElement('div');
      fill.className = 'nvt-rail-progress-fill';
      fill.style.width = pct + '%';
      track.appendChild(fill);
      thumb.appendChild(track);

      // No "Finished" badge on CW cards — full progress bar is enough and
      // avoids looking like the entire series is done.

      // Remove from Continue Watching (same as popup ✕) without navigating.
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'nvt-rail-remove';
      removeBtn.setAttribute('aria-label', 'Remove from Continue Watching');
      removeBtn.title = 'Remove from Continue Watching';
      removeBtn.textContent = '\u00d7';
      removeBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          if (item && item.id) await NVT.removeHistory(item.id);
          scheduleRender(50);
        } catch (err) {
          console.debug('[Nepu Home Rails] remove Continue Watching failed', err);
        }
      });
      thumb.appendChild(removeBtn);
    }

    const title = document.createElement('div');
    title.className = 'nvt-rail-title';
    title.textContent = item.title || item.url || 'Untitled';

    a.appendChild(thumb);
    a.appendChild(title);

    if (mode === 'continue') {
      const meta = document.createElement('div');
      meta.className = 'nvt-rail-meta';
      meta.textContent = progressText(item, useTime);
      a.appendChild(meta);
    } else if (mode === 'recommend' && (item.year || item.mediaType)) {
      const meta = document.createElement('div');
      meta.className = 'nvt-rail-meta';
      const bits = [];
      if (item.year) bits.push(String(item.year));
      if (item.mediaType === 'tv') bits.push('TV Series');
      else if (item.mediaType === 'movie') bits.push('Movie');
      meta.textContent = bits.join(' · ');
      a.appendChild(meta);
    }

    return a;
  }

  function buildSection(headingText, items, mode, useTime) {
    if (!items.length) return null;
    const section = document.createElement('div');
    section.className = 'nvt-rail-section';

    // Reuse the site's own ".app-heading"/".text" classes so our rows match
    // the surrounding "Latest ..." rows visually.
    const heading = document.createElement('div');
    heading.className = 'app-heading';
    const text = document.createElement('div');
    text.className = 'text';
    text.textContent = headingText;
    heading.appendChild(text);

    const rail = document.createElement('div');
    rail.className = 'nvt-rail';
    items.forEach((item) => rail.appendChild(buildCard(item, mode, useTime)));

    section.appendChild(heading);
    section.appendChild(rail);
    return section;
  }

  function removeWrapper() {
    const el = document.getElementById(WRAPPER_ID);
    if (el) el.remove();
  }

  async function renderHomeRails() {
    try {
      const anchor = findAnchor();
      if (!anchor) {
        removeWrapper();
        lastSignature = null;
        return;
      }

      const [history, watchlist, settings, recommendations] = await Promise.all([
        NVT.listHistory(),
        NVT.listWatchlist(),
        NVT.getSettings(),
        NVT.getRecommendations(),
      ]);

      // Finished titles stay until removed manually; show keys merge episodes (no dupes).
      const continuing = (history || [])
        .filter((h) => h && !h.deleted && (h.progress || 0) >= settings.minProgressToTrack)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, 12);

      const watching = NVT.sortWatchlist(watchlist || []).slice(0, 12);

      // Prefer multi-rail cache. Fall back to legacy single `items`/`reason`
      // for caches written before multi-rail support.
      let discoveryRails = [];
      if (settings.recommendationsEnabled !== false) {
        const cachedRails = Array.isArray(recommendations.rails) ? recommendations.rails : [];
        if (cachedRails.length) {
          discoveryRails = cachedRails
            .filter((r) => r && r.title && Array.isArray(r.items) && r.items.length)
            .map((r) => ({
              id: r.id || r.title,
              title: r.title,
              items: r.items.slice(0, 14),
            }));
        } else if ((recommendations.items || []).length) {
          discoveryRails = [
            {
              id: 'legacy',
              title: recommendations.reason || 'Recommended For You',
              items: recommendations.items.slice(0, 14),
            },
          ];
        }
      }

      if (!continuing.length && !watching.length && !discoveryRails.length) {
        removeWrapper();
        lastSignature = null;
        return;
      }

      const signature = JSON.stringify({
        c: continuing.map((h) => [h.id, h.season, h.episode, Math.round((h.progress || 0) * 100), Math.round(h.currentTime || 0)]),
        w: watching.map((w) => [w.id, w.season, w.episode]),
        rails: discoveryRails.map((r) => [r.id, r.title, r.items.map((i) => i.id)]),
        t: !!settings.useTimeProgress,
      });

      let wrapper = document.getElementById(WRAPPER_ID);
      if (signature === lastSignature && wrapper) {
        // Data unchanged — just make sure we're still anchored correctly
        // (the site may have re-rendered the surrounding list).
        if (wrapper.nextSibling !== anchor || wrapper.parentElement !== anchor.parentElement) {
          anchor.parentElement.insertBefore(wrapper, anchor);
        }
        return;
      }
      lastSignature = signature;

      injectStyle();
      if (!wrapper) {
        wrapper = document.createElement('div');
        wrapper.id = WRAPPER_ID;
      } else {
        wrapper.innerHTML = '';
      }

      // Order: personal rails first (Continue / Watchlist), then discovery.
      const continueSection = buildSection('Continue Watching', continuing, 'continue', settings.useTimeProgress);
      const watchlistSection = buildSection('Watchlist', watching, 'watchlist', settings.useTimeProgress);
      if (continueSection) wrapper.appendChild(continueSection);
      if (watchlistSection) wrapper.appendChild(watchlistSection);
      for (const rail of discoveryRails) {
        const section = buildSection(rail.title, rail.items, 'recommend', false);
        if (section) wrapper.appendChild(section);
      }

      anchor.parentElement.insertBefore(wrapper, anchor);
    } catch (err) {
      console.debug('[Nepu Home Rails] render failed', err);
    }
  }

  let debounceTimer = null;
  function scheduleRender(delay) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      renderHomeRails();
    }, delay == null ? 250 : delay);
  }

  function hookNav() {
    const wrap = (name) => {
      const orig = history[name];
      if (typeof orig !== 'function') return;
      history[name] = function (...args) {
        const ret = orig.apply(this, args);
        scheduleRender(400);
        return ret;
      };
    };
    wrap('pushState');
    wrap('replaceState');
    window.addEventListener('popstate', () => scheduleRender(400));
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      const relevant = Object.keys(changes).some(
        (k) => k.startsWith(NVT.HIST_PREFIX) || k.startsWith(NVT.WL_PREFIX) || k === NVT.RECOMMENDATIONS_KEY
      );
      if (relevant) scheduleRender(150);
    });
  } catch (err) {
    /* ignore */
  }

  function boot() {
    hookNav();
    renderHomeRails();
    // The homepage may fill its "Latest ..." rows in asynchronously; a
    // couple of delayed retries catch that without a document-wide
    // MutationObserver (which would risk reacting to our own DOM writes).
    setTimeout(renderHomeRails, 600);
    setTimeout(renderHomeRails, 1800);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
