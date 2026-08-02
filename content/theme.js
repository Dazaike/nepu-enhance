/**
 * Nepu Modern UI Overhaul — theme class toggle.
 *
 * Applies the `nvt-modern-ui` class to documentElement so theme.css styles
 * take effect immediately on page load, and reacts to live settings toggles
 * from the popup/options page.
 */
(function () {
  'use strict';

  function applyTheme(enabled) {
    if (enabled !== false) {
      document.documentElement.classList.add('nvt-modern-ui');
    } else {
      document.documentElement.classList.remove('nvt-modern-ui');
    }
  }

  // Apply immediately using local storage or fallback defaults
  try {
    chrome.storage.local.get('settings', (res) => {
      const s = res && res.settings;
      applyTheme(!s || s.nepuModernUi !== false);
    });
  } catch (_) {
    applyTheme(true);
  }

  // Listen for live setting changes
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.settings) return;
      const s = changes.settings.newValue;
      applyTheme(!s || s.nepuModernUi !== false);
    });
  } catch (_) {
    /* ignore */
  }
})();
