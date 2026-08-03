/**
 * HTML5 <video> watch-progress tracker for Nepu (nepu.to/.is/.net — see
 * manifest.json content_scripts). Powers "Continue Watching" and
 * auto-resume. Defensive by design: any failure here must never break the
 * host page.
 */
(function () {
  'use strict';

  // Every <video> we've ever attached a listener to, so repeated scans
  // (MutationObserver callbacks, the fallback poll) never double-attach.
  const instrumented = new WeakSet();

  // Per-video state so late duration / play events can still qualify a
  // video that was discovered before metadata was ready (common with
  // FluidPlayer / SPA embeds — first qualify() fails, then never retried).
  const videoStates = new WeakMap();

  // Videos whose duration has qualified (finite, >= minDurationSeconds) and
  // therefore have active tracking listeners. Used by the visibilitychange
  // flush, which needs to enumerate currently-live videos.
  const activeVideos = new Set();

  function formatClock(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) {
      return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    }
    return `${m}:${String(sec).padStart(2, '0')}`;
  }

  function showResumeToast(seconds) {
    try {
      const toast = document.createElement('div');
      toast.textContent = `Resumed from ${formatClock(seconds)}`;
      Object.assign(toast.style, {
        position: 'fixed',
        left: '12px',
        bottom: '12px',
        zIndex: '2147483647',
        background: 'rgba(20, 20, 24, 0.85)',
        color: '#fff',
        font: '12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        padding: '8px 14px',
        borderRadius: '8px',
        boxShadow: '0 2px 10px rgba(0,0,0,0.35)',
        pointerEvents: 'none',
        transition: 'opacity 0.4s ease',
        opacity: '1',
      });
      document.documentElement.appendChild(toast);
      setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 450);
      }, 2500);
    } catch (err) {
      console.debug('[NVT tracker] toast failed', err);
    }
  }

  function getPageIdentity() {
    let season = null;
    let episode = null;
    try {
      const identified = identifyTitle();
      if (identified && identified.season != null && identified.episode != null) {
        season = identified.season;
        episode = identified.episode;
      }
    } catch (err) {
      console.debug('[NVT tracker] identifyTitle failed for identity', err);
    }
    // Prefer pathname for stable history keys (search/hash often changes).
    return {
      host: location.hostname,
      path: location.pathname || '/',
      url: location.href,
      season,
      episode,
    };
  }

  function getTitle() {
    // identifyTitle() (common/nepu-title.js) strips SxxExx tags and years
    // from slug/JSON-LD/og:title/document.title, so Continue Watching shows
    // "Rick and Morty" instead of "Rick And Morty S09E09 2013".
    try {
      const identified = identifyTitle();
      if (identified && identified.title) return identified.title;
    } catch (err) {
      console.debug('[NVT tracker] identifyTitle failed, falling back', err);
    }
    const og = document.querySelector('meta[property="og:title"]');
    const raw = (og && og.content) || document.title || '';
    return raw.trim();
  }

  function getPoster(video) {
    const og = document.querySelector('meta[property="og:image"]');
    if (og && og.content) return og.content;
    if (video && video.poster) return video.poster;
    try {
      return `${location.origin}/favicon.ico`;
    } catch (err) {
      return '';
    }
  }

  async function persist(video, overrides) {
    try {
      const duration = video.duration;
      const rawProgress = duration > 0 ? video.currentTime / duration : 0;
      const progress = Math.min(1, Math.max(0, rawProgress));
      const settings = await NVT.getSettings();
      const completed = progress >= settings.completedThreshold;
      const payload = Object.assign(
        {
          ...getPageIdentity(),
          title: getTitle(),
          poster: getPoster(video),
          currentTime: video.currentTime,
          duration,
          progress,
          completed,
        },
        overrides || {}
      );
      const shouldPersist =
        payload.progress >= settings.minProgressToTrack || payload.completed;
      if (!shouldPersist) return;
      await NVT.upsertHistory(payload);
      // Finished this episode → if Watchlist is still on the same S/E,
      // move the bookmark to the next episode (e.g. E2 done → bookmark E3).
      if (payload.completed) {
        try {
          await NVT.advanceWatchlistAfterEpisodeComplete(
            payload.host,
            payload.path,
            payload.season,
            payload.episode
          );
        } catch (advErr) {
          console.debug('[NVT tracker] watchlist advance failed', advErr);
        }
      }
    } catch (err) {
      console.debug('[NVT tracker] persist failed', err);
    }
  }

  function setupVideo(video, settings) {
    // Already wired — but duration often arrives *after* first discovery.
    // Retry qualify on every rescan so late metadata still enables tracking.
    if (instrumented.has(video)) {
      const existing = videoStates.get(video);
      if (existing && typeof existing.qualify === 'function') existing.qualify();
      return;
    }
    instrumented.add(video);

    const state = {
      lastSaveWallClock: 0,
      resumed: false,
      qualified: false,
    };
    videoStates.set(video, state);

    async function maybeResume() {
      if (!settings.resumeEnabled || state.resumed) return;
      try {
        const { host, path, season, episode } = getPageIdentity();
        const entry = await NVT.getHistoryFor(host, path);
        // Same show, next episode: the entry now on file may belong to a
        // different (often equal-length) episode — never seek into it.
        const sameEpisode =
          entry && entry.season == null && entry.episode == null
            ? season == null && episode == null
            : entry && entry.season === season && entry.episode === episode;
        if (
          entry &&
          sameEpisode &&
          !entry.completed &&
          entry.progress > settings.minProgressToTrack &&
          entry.progress < settings.completedThreshold &&
          Math.abs((entry.duration || 0) - video.duration) < 5 &&
          video.currentTime < 1
        ) {
          try {
            video.currentTime = entry.currentTime;
            state.resumed = true;
            showResumeToast(entry.currentTime);
          } catch (seekErr) {
            console.debug('[NVT tracker] resume seek failed', seekErr);
          }
        }
      } catch (err) {
        console.debug('[NVT tracker] resume lookup failed', err);
      }
    }

    function onTimeUpdate() {
      if (video.seeking || video.paused) return;
      const now = Date.now();
      if (now - state.lastSaveWallClock < 5000) return;
      state.lastSaveWallClock = now;
      persist(video);
    }

    function onPause() {
      state.lastSaveWallClock = Date.now();
      persist(video);
    }

    function onEnded() {
      state.lastSaveWallClock = Date.now();
      persist(video, { progress: 1, completed: true });
    }

    function qualify() {
      if (state.qualified) return;
      const duration = video.duration;
      // Some players report 0 / NaN until media is actually playing.
      if (!Number.isFinite(duration) || duration <= 0) return;
      // Soft floor: still respect setting, but treat very short clips only
      // once we know duration. Default minDurationSeconds is 30.
      if (duration < settings.minDurationSeconds) return;

      state.qualified = true;
      activeVideos.add(video);
      video.addEventListener('timeupdate', onTimeUpdate);
      video.addEventListener('pause', onPause);
      video.addEventListener('ended', onEnded);
      // Immediate save once qualified if already past the progress threshold
      // (user scrubbed / mid-play when we finally got duration).
      if (!video.paused && video.currentTime > 0) {
        persist(video);
      }
      maybeResume();
    }
    state.qualify = qualify;

    // Players fire different readiness events; listen to all common ones.
    video.addEventListener('loadedmetadata', qualify);
    video.addEventListener('durationchange', qualify);
    video.addEventListener('loadeddata', qualify);
    video.addEventListener('canplay', qualify);
    video.addEventListener('play', qualify);
    video.addEventListener('playing', qualify);
    // Metadata may already be available (cached / late scan).
    qualify();
  }

  // Nepu (and similar aggregators) frequently embed the actual player in a
  // same-origin iframe per "server"/source. Cross-origin iframes are simply
  // unreachable from here (browser security), but same-origin ones aren't.
  function sameOriginIframeDocs(rootDoc) {
    const docs = [];
    const base = rootDoc || document;
    try {
      base.querySelectorAll('iframe').forEach((frame) => {
        try {
          const doc = frame.contentDocument || (frame.contentWindow && frame.contentWindow.document);
          if (doc) docs.push(doc);
        } catch (_) {
          /* cross-origin — inaccessible */
        }
      });
    } catch (_) {
      /* ignore */
    }
    return docs;
  }

  /** Collect <video> nodes including open shadow roots (FluidPlayer / custom). */
  function collectVideos(root) {
    const out = [];
    const seen = new Set();

    function add(v) {
      if (v && v.tagName === 'VIDEO' && !seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
    }

    function walk(node) {
      if (!node) return;
      try {
        if (node.tagName === 'VIDEO') add(node);
        if (node.querySelectorAll) {
          node.querySelectorAll('video').forEach(add);
          // Open shadow roots on custom elements
          node.querySelectorAll('*').forEach((el) => {
            if (el.shadowRoot) walk(el.shadowRoot);
          });
        }
        if (node.shadowRoot) walk(node.shadowRoot);
      } catch (_) {
        /* ignore */
      }
    }

    walk(root);
    return out;
  }

  function scanForVideos(root, settings) {
    try {
      if (!root) return;
      collectVideos(root).forEach((video) => setupVideo(video, settings));

      // Top-level document: also walk same-origin iframes (and their shadows).
      if (root === document || root === document.documentElement || root === document.body) {
        sameOriginIframeDocs(document).forEach((doc) => {
          collectVideos(doc).forEach((video) => setupVideo(video, settings));
        });
      }
    } catch (err) {
      console.debug('[NVT tracker] scan failed', err);
    }
  }

  /**
   * Opportunistic Dropbox sync when a Nepu page loads (in addition to the
   * background 5‑minute alarm). background.js throttles network calls
   * (min 5 minutes between auto syncs) and no-ops when Dropbox isn't
   * connected or auto-sync is off — so this is cheap to fire often.
   * Independent of trackingEnabled.
   */
  function maybeSyncDropbox(settings) {
    try {
      if (settings.dropboxAutoSync === false) return;
      chrome.runtime.sendMessage({ type: 'DROPBOX_SYNC' }, () => {
        if (chrome.runtime.lastError) {
          console.debug('[NVT tracker] dropbox sync message failed', chrome.runtime.lastError.message);
        }
      });
    } catch (err) {
      console.debug('[NVT tracker] dropbox sync trigger failed', err);
    }
  }

  async function main() {
    const settings = await NVT.getSettings();
    maybeSyncDropbox(settings);
    // SPA navigations rarely reload the document — re-ping sync when the
    // tab becomes visible again so long sessions still push/pull.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        NVT.getSettings()
          .then((s) => maybeSyncDropbox(s))
          .catch(() => {});
      }
    });
    if (!settings.trackingEnabled) return;

    scanForVideos(document, settings);

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType !== 1) return; // ELEMENT_NODE
          scanForVideos(node, settings);
        });
      }
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    // Cheap, low-frequency defensive fallback: some custom/SPA players swap
    // <video> src, put media in shadow DOM, or only set duration after play.
    // Re-scanning is cheap; already-instrumented videos re-try qualify only.
    const fallbackTimer = setInterval(() => {
      scanForVideos(document, settings);
    }, 2500);
    window.addEventListener(
      'beforeunload',
      () => clearInterval(fallbackTimer),
      { once: true }
    );

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'hidden') return;
      activeVideos.forEach((video) => {
        if (!video.isConnected) return;
        persist(video);
      });
    });
  }

  try {
    main().catch((err) => console.debug('[NVT tracker] init failed', err));
  } catch (err) {
    console.debug('[NVT tracker] init threw', err);
  }
})();
