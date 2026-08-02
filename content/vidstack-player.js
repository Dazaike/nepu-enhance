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
    document.head.appendChild(script);
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

    injectAssets();

    const wrapper = findPlayerWrapper(video || document.querySelector('video'));
    if (!wrapper || !wrapper.parentElement) {
      console.warn('[Nepu Watch Tracker] Vidstack: could not locate player wrapper to replace.');
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
      if (provider && provider.type === 'hls') {
        provider.library = chrome.runtime.getURL('vendor/vidstack/hls.min.js');
      }
    });
    player.style.width = '100%';
    player.style.aspectRatio = '16 / 9';

    const outlet = document.createElement('media-outlet');
    const skin = document.createElement('media-community-skin');
    player.appendChild(outlet);
    player.appendChild(skin);

    wrapper.parentElement.insertBefore(player, wrapper.nextSibling);
  }

  window.addEventListener('nvt:video-source-found', (e) => {
    const detail = e.detail || {};
    if (!detail.url) return;
    chrome.storage.local.get('settings', (res) => {
      const settings = res && res.settings;
      if (!settings || settings.vidstackPlayerEnabled !== true) return;
      mount(detail.url, document.querySelector('video'));
    });
  });
})();
