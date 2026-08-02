/**
 * Injects "Continue Watching" and "Watchlist" rails directly into Nepu
 * pages (home/browse pages that have the site's own ".app-heading" rows,
 * e.g. "Latest TV Episodes"), right above the first such heading. This is
 * a read-only view onto the shared NVT store — editing still happens in
 * the extension popup. Nothing renders if both lists are empty.
 */
(function () {
  'use strict';

  const WRAPPER_ID = 'nvt-home-rails';
  let lastSignature = null;

  function injectStyle() {
    if (document.getElementById('nvt-home-rails-style')) return;
    const style = document.createElement('style');
    style.id = 'nvt-home-rails-style';
    style.textContent = `
      #${WRAPPER_ID} { margin-bottom: 8px; }
      .nvt-rail-section { margin-bottom: 20px; }
      .nvt-rail {
        display: flex;
        gap: 12px;
        overflow-x: auto;
        padding-bottom: 8px;
        scrollbar-width: none;
      }
      .nvt-rail::-webkit-scrollbar {
        display: none;
      }
      .nvt-rail-card {
        flex: 0 0 auto;
        width: 140px;
        color: inherit;
        text-decoration: none;
        display: block;
      }
      .nvt-rail-thumb {
        position: relative;
        width: 140px;
        height: 197px;
        border-radius: 8px;
        overflow: hidden;
        background: #1f2937;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: transform 0.15s ease;
      }
      .nvt-rail-card:hover .nvt-rail-thumb {
        transform: scale(1.03);
      }
      .nvt-rail-thumb img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
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
      }
      .nvt-rail-badge.nvt-rail-new-release {
        background: #10b981 !important;
        color: #042f2e !important;
        font-weight: 700;
        box-shadow: 0 2px 6px rgba(16, 185, 129, 0.4);
      }
      .nvt-rail-badge.nvt-rail-rating {
        background: rgba(11, 15, 25, 0.75) !important;
        color: #fbbf24 !important;
        font-weight: 700;
        border: 1px solid rgba(251, 191, 36, 0.4);
      }
      .nvt-rail-title {
        font-size: 12.5px;
        margin-top: 6px;
        line-height: 1.3;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        word-break: break-word;
      }
      .nvt-rail-meta {
        font-size: 11px;
        margin-top: 2px;
        opacity: 0.65;
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

  /** Recommendation cards have no direct nepu.is URL (TMDB IDs don't map
   * to nepu's internal catalog IDs) — submit nepu's own live search form
   * instead, exactly as if the user had typed the title and hit enter. */
  function searchNepuFor(title) {
    try {
      const input = document.getElementById('search-input');
      const form = document.getElementById('navbarToggler');
      if (input && form && typeof form.submit === 'function') {
        input.value = title;
        form.submit();
        return true;
      }
    } catch (err) {
      console.debug('[Nepu Home Rails] search submit failed', err);
    }
    return false;
  }

  function progressText(item, useTime) {
    if (useTime) return `${formatClock(item.currentTime)} / ${formatClock(item.duration)}`;
    const pct = Math.max(0, Math.min(100, Math.round((item.progress || 0) * 100)));
    return `${pct}%`;
  }

  function buildCard(item, mode, useTime) {
    const a = document.createElement('a');
    a.className = 'nvt-rail-card';
    if (mode === 'recommend') {
      a.href = '#';
      a.addEventListener('click', (e) => {
        e.preventDefault();
        searchNepuFor(item.title);
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
      if (item.rating != null) {
        const badge = document.createElement('div');
        badge.className = 'nvt-rail-badge nvt-rail-rating';
        badge.textContent = `★ ${item.rating}`;
        thumb.appendChild(badge);
      }
    } else if (mode === 'watchlist' && item.hasNewRelease && item.latestSeason != null && item.latestEpisode != null) {
      const badge = document.createElement('div');
      badge.className = 'nvt-rail-badge nvt-rail-new-release';
      badge.textContent = `NEW S${item.latestSeason} E${item.latestEpisode}`;
      thumb.appendChild(badge);
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
      const pct = Math.max(0, Math.min(100, Math.round((item.progress || 0) * 100)));
      const track = document.createElement('div');
      track.className = 'nvt-rail-progress';
      const fill = document.createElement('div');
      fill.className = 'nvt-rail-progress-fill';
      fill.style.width = pct + '%';
      track.appendChild(fill);
      thumb.appendChild(track);
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

      const continuing = (history || [])
        .filter(
          (h) =>
            h &&
            !h.completed &&
            (h.progress || 0) >= settings.minProgressToTrack &&
            (h.progress || 0) < settings.completedThreshold
        )
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, 12);

      const watching = (watchlist || [])
        .slice()
        .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
        .slice(0, 12);

      const recommended = settings.recommendationsEnabled !== false ? (recommendations.items || []).slice(0, 12) : [];

      if (!continuing.length && !watching.length && !recommended.length) {
        removeWrapper();
        lastSignature = null;
        return;
      }

      const signature = JSON.stringify({
        c: continuing.map((h) => [h.id, h.season, h.episode, Math.round((h.progress || 0) * 100), Math.round(h.currentTime || 0)]),
        w: watching.map((w) => [w.id, w.season, w.episode]),
        r: recommended.map((r) => r.id),
        reason: recommendations.reason || '',
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

      const continueSection = buildSection('Continue Watching', continuing, 'continue', settings.useTimeProgress);
      const watchlistSection = buildSection('Watchlist', watching, 'watchlist', settings.useTimeProgress);
      const recommendSection = buildSection(recommendations.reason || 'Recommended For You', recommended, 'recommend', false);
      if (continueSection) wrapper.appendChild(continueSection);
      if (watchlistSection) wrapper.appendChild(watchlistSection);
      if (recommendSection) wrapper.appendChild(recommendSection);

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
