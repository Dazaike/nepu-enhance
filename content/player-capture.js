/**
 * EXPERIMENTAL — Vidstack player swap, stage 1: source capture.
 *
 * Runs in the page's MAIN world (declared via manifest "world": "MAIN"),
 * at document_start, so it patches fetch/XHR/video.src *before* nepu's own
 * player glue (playerjs.js -> FluidPlayer) has a chance to load the real
 * stream. This is required because the video source is never present in
 * the static HTML - it's resolved dynamically, and for HLS streams the
 * <video> element typically ends up with a `blob:` URL (MediaSource/hls.js)
 * that is *only* valid for the player instance that created it. We need
 * the original manifest/file URL, which only shows up as a network
 * request, not as `video.src`.
 *
 * Communicates the captured URL to the isolated-world content script
 * (content/vidstack-player.js) via a DOM CustomEvent, since MAIN and
 * ISOLATED worlds don't share JS state but do share the DOM/event target.
 *
 * KNOWN LIMITATION: only sees requests made in the frame this script runs
 * in. If a given "server" on nepu.is loads playback inside a cross-origin
 * iframe (a different embed host), this script never runs there and
 * can't see that frame's network activity - only chrome.webRequest in the
 * background service worker can (see background.js `nvtWebRequestCapture`).
 */
(function () {
  'use strict';

  if (window.__nvtPlayerCaptureInstalled) return;
  window.__nvtPlayerCaptureInstalled = true;

  const VIDEO_URL_RE = /\.(m3u8|mp4|webm|mkv)(\?|#|$)/i;
  let reported = false;

  function report(url, source) {
    if (reported || !url || typeof url !== 'string') return;
    if (!VIDEO_URL_RE.test(url)) return;
    reported = true;
    try {
      window.dispatchEvent(
        new CustomEvent('nvt:video-source-found', {
          detail: { url, source },
        })
      );
    } catch (_) {
      /* ignore */
    }
  }

  // --- fetch() ---
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      try {
        const url = typeof input === 'string' ? input : input && input.url;
        report(url, 'fetch');
      } catch (_) {
        /* ignore */
      }
      return origFetch.apply(this, arguments);
    };
  }

  // --- XMLHttpRequest ---
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      report(url, 'xhr');
    } catch (_) {
      /* ignore */
    }
    return origOpen.apply(this, arguments);
  };

  // --- <video>.src / <source> direct assignment fallback (covers plain
  // mp4 links that never go through fetch/XHR, e.g. set as a literal
  // attribute by an inline script). Blob URLs are intentionally ignored
  // here - they're not reusable outside their originating player. ---
  function watchVideo(video) {
    if (!video || video.__nvtWatched) return;
    video.__nvtWatched = true;
    const check = () => {
      const src = video.currentSrc || video.src;
      if (src && !src.startsWith('blob:')) report(src, 'video-src');
    };
    video.addEventListener('loadstart', check);
    video.addEventListener('loadedmetadata', check);
    check();
  }

  function scan(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return;
    root.querySelectorAll('video').forEach(watchVideo);
  }

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      m.addedNodes.forEach((node) => {
        if (node.nodeType !== 1) return;
        if (node.tagName === 'VIDEO') watchVideo(node);
        else scan(node);
      });
    }
  });

  function start() {
    scan(document);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
