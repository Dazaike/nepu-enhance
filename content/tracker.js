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
    return {
      host: location.hostname,
      path: location.pathname + location.search,
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
    } catch (err) {
      console.debug('[NVT tracker] persist failed', err);
    }
  }

  function setupVideo(video, settings) {
    if (instrumented.has(video)) return;
    instrumented.add(video);

    const state = {
      lastSaveWallClock: 0,
      resumed: false,
      qualified: false,
    };

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
      if (!Number.isFinite(duration) || duration < settings.minDurationSeconds) {
        return;
      }
      state.qualified = true;
      activeVideos.add(video);
      video.addEventListener('timeupdate', onTimeUpdate);
      video.addEventListener('pause', onPause);
      video.addEventListener('ended', onEnded);
      maybeResume();
    }

    video.addEventListener('loadedmetadata', qualify);
    // Metadata may already be available (e.g. a cached / fast-loading video
    // discovered by a late scan), so check immediately too.
    qualify();
  }

  // Nepu (and similar aggregators) frequently embed the actual player in a
  // same-origin iframe per "server"/source. Cross-origin iframes are simply
  // unreachable from here (browser security), but same-origin ones aren't —
  // reuse the same reachable-frame walk content/subtitles.js already relies
  // on so Continue Watching keeps tracking regardless of which server the
  // page embeds.
  function sameOriginIframeDocs() {
    const docs = [];
    try {
      document.querySelectorAll('iframe').forEach((frame) => {
        try {
          const doc = frame.contentDocument || (frame.contentWindow && frame.contentWindow.document);
          if (doc) docs.push(doc);
        } catch (_) {
          /* cross-origin — inaccessible from the outer page, nothing to do */
        }
      });
    } catch (_) {
      /* ignore */
    }
    return docs;
  }

  function scanForVideos(root, settings) {
    try {
      if (root.tagName === 'VIDEO') {
        setupVideo(root, settings);
      }
      if (typeof root.querySelectorAll === 'function') {
        root.querySelectorAll('video').forEach((video) => {
          setupVideo(video, settings);
        });
        if (root === document) {
          sameOriginIframeDocs().forEach((doc) => {
            doc.querySelectorAll('video').forEach((video) => setupVideo(video, settings));
          });
        }
      }
    } catch (err) {
      console.debug('[NVT tracker] scan failed', err);
    }
  }

  async function main() {
    const settings = await NVT.getSettings();
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
    // <video> src or attach it inside shadow DOM in ways the observer can
    // miss, or never fire loadedmetadata reliably. Re-scanning is cheap —
    // already-instrumented videos are skipped via the WeakSet guard.
    const fallbackTimer = setInterval(() => {
      scanForVideos(document, settings);
    }, 5000);
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
