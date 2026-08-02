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
 * Communicates with the isolated-world content script
 * (content/vidstack-player.js) via CustomEvents on `document` (not
 * `window` - MAIN and ISOLATED worlds each have their own `window`
 * global; only `document` is actually shared between them):
 * - `nvt:video-source-found` - a plausible source URL was captured.
 * - `nvt:debug` - a diagnostic message, relayed into the extension's
 *   persistent debug log (this world has no chrome.storage access, so it
 *   cannot write there directly).
 * A `data-nvt-video-source` attribute on <html> is also set as a fallback
 * for the case where the source is found before the isolated script's
 * listener is registered (this runs at document_start, the isolated
 * player script at document_idle).
 *
 * KNOWN LIMITATION: only sees requests made in the frame this script runs
 * in. If a given "server" on nepu.is loads playback inside a cross-origin
 * iframe (a different embed host), this script never runs there and
 * there is no cross-frame fallback (see content/vidstack-player.js).
 */
(function () {
  'use strict';

  if (window.__nvtPlayerCaptureInstalled) return;
  window.__nvtPlayerCaptureInstalled = true;

  function debug(message) {
    try {
      document.dispatchEvent(new CustomEvent('nvt:debug', { detail: { message } }));
    } catch (_) {
      /* ignore */
    }
  }

  debug('player-capture.js installed on ' + location.href);

  const VIDEO_URL_RE = /\.(m3u8|mp4|webm|mkv)(\?|#|$)/i;
  let reported = false;

  function report(url, source) {
    if (reported || !url || typeof url !== 'string') return;
    if (!VIDEO_URL_RE.test(url)) return;
    reported = true;
    debug('source captured via ' + source + ': ' + url);
    try {
      document.documentElement.dataset.nvtVideoSource = url;
      document.dispatchEvent(
        new CustomEvent('nvt:video-source-found', {
          detail: { url, source },
        })
      );
    } catch (err) {
      debug('report() failed: ' + err);
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
    debug('found <video> element, watching for src');
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

  // Diagnostic snapshot a few seconds in: distinguishes "no video ever
  // appeared" from "a video exists but only ever got a blob: src" (the
  // latter usually means the manifest was fetched from a frame this
  // script never ran in - e.g. a same-site iframe on a subdomain our
  // match patterns don't cover, or a genuinely cross-origin embed).
  setTimeout(() => {
    debug('5s check: this frame is ' + (window.top === window.self ? 'the TOP frame' : 'an IFRAME') + ' at ' + location.href);
    const iframes = document.querySelectorAll('iframe');
    if (iframes.length) {
      iframes.forEach((f, i) => debug('5s check: iframe[' + i + '] src=' + (f.src || '(no src attribute)')));
    } else {
      debug('5s check: no <iframe> elements found in this frame');
    }
    if (reported) return;
    const videos = document.querySelectorAll('video');
    if (!videos.length) {
      debug('5s check: no <video> element found anywhere in this frame yet');
      return;
    }
    videos.forEach((v, i) => {
      debug('5s check: video[' + i + '] src=' + (v.currentSrc || v.src || '(none)'));
    });
  }, 5000);
})();
