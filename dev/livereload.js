/**
 * Dev-only: auto-reload the extension when files change.
 * Pair with:  python3 dev/watch.py
 *
 * Protocol matches https://github.com/wader/crxreload (long-poll on
 * http://localhost:8080/crxreload-request). Uses fetch (MV3 service worker).
 *
 * Loaded via importScripts from background.js — remove/skip for releases.
 */
(function () {
  'use strict';

  const URL = 'http://localhost:8080/crxreload-request';
  let stopped = false;

  async function loop() {
    while (!stopped) {
      try {
        const res = await fetch(URL, { cache: 'no-store' });
        if (res.ok) {
          console.log('[Nepu livereload] change detected — reloading extension');
          chrome.runtime.reload();
          return;
        }
      } catch (err) {
        // Watcher not running yet — retry quietly.
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  loop();
})();
