/**
 * EXPERIMENTAL — Vidstack player swap, stage 2: mount.
 *
 * Gated behind settings.vidstackPlayerEnabled (default OFF). Listens for
 * the `nvt:video-source-found` event dispatched by the MAIN-world
 * content/player-capture.js script, hides nepu's original player
 * (FluidPlayer, or whatever wraps the <video>), and mounts a Vidstack
 * player (bundled locally in vendor/vidstack/) pointed at the captured
 * source in its place.
 *
 * DIAGNOSTICS: nepu.is runs an anti-devtools script, so `console.debug`
 * output is often unreadable in practice. Every step here is instead
 * persisted via NVT.pushDebugLog() into chrome.storage.local - view it
 * from the extension's own Options page (Settings tab), which nepu.is
 * has no way to interfere with.
 *
 * This is a best-effort reskin of playback, NOT a validated integration:
 * - Bypasses FluidPlayer's ad delivery (VAST/VMAP) entirely as a side
 *   effect - there is no ad support in this path.
 * - Only works when the real source is resolved in *this* frame. If nepu
 *   routes a given "server" through a cross-origin iframe, this script
 *   never sees it - there is no cross-frame fallback (would require
 *   chrome.webRequest + an `<all_urls>` host permission, not added here
 *   given this feature is opt-in and experimental).
 * - The HLS provider's library is pinned to the vendored hls.min.js via
 *   the `provider-change` event below (no declarative attribute exists
 *   for this in vidstack 0.6.x); if that ever fails it silently falls
 *   back to fetching hls.js from jsdelivr at runtime.
 * - Vidstack's icon set is fetched lazily from the jsdelivr media-icons
 *   CDN at runtime (not vendored) - a soft external dependency for icon
 *   glyphs only; playback itself does not depend on it.
 */
(function () {
  'use strict';

  if (window.__nvtVidstackMountInstalled) return;
  window.__nvtVidstackMountInstalled = true;

  function log(message) {
    console.debug('[NVT vidstack]', message);
    if (typeof NVT !== 'undefined' && NVT.pushDebugLog) NVT.pushDebugLog('vidstack', message);
  }

  log('vidstack-player.js installed on ' + location.href);

  let assetsLoaded = false;
  let mounted = false;

  function injectAssets() {
    if (assetsLoaded) return;
    assetsLoaded = true;
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = chrome.runtime.getURL('vendor/vidstack/vidstack.css');
    document.head.appendChild(css);

    const script = document.createElement('script');
    script.type = 'module';
    script.src = chrome.runtime.getURL('vendor/vidstack/vidstack.min.js');
    script.onerror = () => log('FAILED to load vendor/vidstack/vidstack.min.js - check web_accessible_resources');
    document.head.appendChild(script);
    log('injected vidstack assets (css + module script)');
  }

  /** Walk up from the <video> to find the widest reasonable wrapper to
   * hide (FluidPlayer typically wraps the video in a few nested divs);
   * stop climbing once we would leave the immediate player area. */
  function findPlayerWrapper(video) {
    let el = video;
    for (let i = 0; i < 4 && el.parentElement; i++) {
      const parent = el.parentElement;
      // Stop climbing once the parent holds more than just the player
      // (e.g. the page body/main content wrapper).
      if (parent.children.length > 3) break;
      el = parent;
    }
    return el;
  }

  function mount(url, video) {
    if (mounted) return;
    mounted = true;
    log('mounting for source: ' + url);

    injectAssets();

    const target = video || document.querySelector('video');
    if (!target) {
      log('ABORT: no <video> element found on the page at mount time');
      return;
    }
    const wrapper = findPlayerWrapper(target);
    if (!wrapper || !wrapper.parentElement) {
      log('ABORT: could not locate a player wrapper to replace');
      return;
    }

    wrapper.style.display = 'none';

    const player = document.createElement('media-player');
    player.setAttribute('src', url);
    player.setAttribute('crossorigin', '');
    player.setAttribute('playsinline', '');
    // `<media-player>` has no declarative attribute for the HLS provider's
    // library source - it must be set on the provider instance itself via
    // the `provider-change` event, or it silently falls back to fetching
    // hls.js from jsdelivr at runtime.
    player.addEventListener('provider-change', (e) => {
      const provider = e.detail;
      log('provider-change: ' + (provider && provider.type));
      if (provider && provider.type === 'hls') {
        provider.library = chrome.runtime.getURL('vendor/vidstack/hls.min.js');
      }
    });
    player.addEventListener('error', (e) => log('media-player error: ' + (e && e.detail && e.detail.message)));
    player.style.width = '100%';
    player.style.aspectRatio = '16 / 9';

    const outlet = document.createElement('media-outlet');
    const skin = document.createElement('media-community-skin');
    player.appendChild(outlet);
    player.appendChild(skin);

    wrapper.parentElement.insertBefore(player, wrapper.nextSibling);
    log('player element inserted into DOM');

    customElements.whenDefined('media-player').then(
      () => log('media-player custom element upgraded successfully'),
      (err) => log('media-player custom element FAILED to upgrade: ' + err)
    );
    setTimeout(() => {
      if (!customElements.get('media-player')) {
        log('WARNING: media-player still not defined 5s after mount - vidstack.min.js likely failed to load/execute');
      }
    }, 5000);
  }

  function maybeMount(url, source) {
    if (!url) return;
    chrome.storage.local.get('settings', (res) => {
      const settings = res && res.settings;
      if (!settings || settings.vidstackPlayerEnabled !== true) {
        log('source found via ' + source + ' but feature is disabled in Settings - ignoring');
        return;
      }
      mount(url, document.querySelector('video'));
    });
  }

  document.addEventListener('nvt:video-source-found', (e) => {
    const detail = e.detail || {};
    log('event received: source via ' + detail.source + ' -> ' + detail.url);
    maybeMount(detail.url, 'event:' + detail.source);
  });

  // Relay from the MAIN-world capture script, which cannot call
  // chrome.storage itself (MAIN world runs with the page's own privileges,
  // not the extension's).
  document.addEventListener('nvt:debug', (e) => {
    log('[capture] ' + (e.detail && e.detail.message));
  });

  // Covers the case where player-capture.js (document_start) found the
  // source and dispatched its event before this script (document_idle)
  // had a listener registered.
  const early = document.documentElement.dataset.nvtVideoSource;
  if (early) {
    log('found early-attribute source from before this script loaded: ' + early);
    maybeMount(early, 'early-attribute');
  }
})();
