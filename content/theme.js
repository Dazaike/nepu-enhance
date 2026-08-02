/**
 * Nepu Modern UI Overhaul — theme class toggle + search chrome.
 *
 * - Toggles `nvt-modern-ui` on <html> from settings.
 * - Pins the header search pill (site centers it with left:50%).
 * - Floats typeahead results to document.body with position:fixed so the
 *   hero carousel stacking context cannot cover truncated results.
 */
(function () {
  'use strict';

  function applyTheme(enabled) {
    if (enabled !== false) {
      document.documentElement.classList.add('nvt-modern-ui');
      pinSearchBar();
      floatTypeaheadLists();
    } else {
      document.documentElement.classList.remove('nvt-modern-ui');
    }
  }

  function setImportant(el, props) {
    if (!el || !el.style) return;
    Object.keys(props).forEach((k) => {
      el.style.setProperty(k, props[k], 'important');
    });
  }

  function searchInput() {
    return (
      document.getElementById('search-input') ||
      document.querySelector('.app-search input, .typeahead__field input, .typeahead__query input')
    );
  }

  /** Move the floating search pill left + up (site centers it mid-header). */
  function pinSearchBar() {
    if (!document.documentElement.classList.contains('nvt-modern-ui')) return;

    const hosts = document.querySelectorAll(
      '.header-search-fixed, .header-search, .app-header .app-search, .app .app-search, .app-search'
    );
    hosts.forEach((el) => {
      el.classList.add('nvt-search-pinned');
      const isHost =
        el.classList.contains('header-search-fixed') || el.classList.contains('header-search');
      if (isHost) {
        setImportant(el, {
          position: 'absolute',
          top: '6px',
          left: '112px',
          right: 'auto',
          bottom: 'auto',
          transform: 'none',
          'margin-left': '0',
          'margin-top': '0',
          'margin-right': '0',
          width: 'auto',
          'max-width': 'none',
          display: 'flex',
          'justify-content': 'flex-start',
          'align-items': 'flex-start',
          'z-index': '3000',
          overflow: 'visible',
        });
      } else {
        const open = el.classList.contains('result') || el.matches(':focus-within');
        setImportant(el, {
          'margin-left': '0px',
          'margin-right': '0px',
          'margin-top': '0px',
          'margin-bottom': '0px',
          width: open ? 'min(480px, 72vw)' : 'min(320px, 44vw)',
          'max-width': open ? '520px' : 'none',
          position: 'relative',
          top: '0px',
          left: '0px',
          transform: 'none',
          float: 'none',
          overflow: 'visible',
          'z-index': '3000',
        });
      }
    });
  }

  /**
   * Typeahead lives under .app-search; the hero carousel creates a stacking
   * context that paints over it no matter how high we set z-index on the list.
   * Reparent the open list onto <body> and pin it with position:fixed to the
   * input's viewport box — escapes transforms + paints on top.
   */
  function floatTypeaheadLists() {
    if (!document.documentElement.classList.contains('nvt-modern-ui')) return;

    const input = searchInput();
    if (!input) return;

    const lists = document.querySelectorAll(
      '.typeahead__list, .typeahead__dropdown, .app-search .typeahead__list, ul.typeahead__list'
    );

    lists.forEach((list) => {
      // Skip clearly closed / empty shells
      const cs = window.getComputedStyle(list);
      const hasItems = list.children && list.children.length > 0;
      if (!hasItems && (cs.display === 'none' || cs.visibility === 'hidden')) return;
      if (cs.display === 'none') return;

      // Escape transformed/overflow ancestors
      if (list.parentElement !== document.body) {
        list.dataset.nvtFloated = '1';
        document.body.appendChild(list);
      }
      list.classList.add('nvt-typeahead-float');

      const r = input.getBoundingClientRect();
      const width = Math.min(Math.max(Math.round(r.width) || 320, 480), window.innerWidth - 16);
      let left = Math.round(r.left);
      if (left + width > window.innerWidth - 8) {
        left = Math.max(8, window.innerWidth - width - 8);
      }
      const top = Math.round(r.bottom + 6);
      const maxH = Math.max(160, Math.min(560, window.innerHeight - top - 12));

      setImportant(list, {
        position: 'fixed',
        top: top + 'px',
        left: left + 'px',
        right: 'auto',
        bottom: 'auto',
        width: width + 'px',
        'min-width': width + 'px',
        'max-width': width + 'px',
        'max-height': maxH + 'px',
        'z-index': '2147483000',
        overflow: 'auto',
        'overflow-x': 'hidden',
        margin: '0',
        transform: 'none',
        '-webkit-transform': 'none',
        display: 'block',
        visibility: 'visible',
        opacity: '1',
        'pointer-events': 'auto',
        'background-color': '#131b2e',
        'border-radius': '12px',
        border: '1px solid rgba(255,255,255,0.12)',
        'box-shadow': '0 16px 48px rgba(0,0,0,0.75)',
        padding: '8px 0 12px',
      });
    });
  }

  let pinTimer = null;
  function schedulePin() {
    clearTimeout(pinTimer);
    pinTimer = setTimeout(() => {
      pinSearchBar();
      floatTypeaheadLists();
    }, 30);
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

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.settings) return;
      const s = changes.settings.newValue;
      applyTheme(!s || s.nepuModernUi !== false);
    });
  } catch (_) {
    /* ignore */
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', schedulePin);
  } else {
    schedulePin();
  }
  window.addEventListener('load', schedulePin);
  window.addEventListener('resize', schedulePin);
  window.addEventListener('scroll', schedulePin, true);
  setTimeout(schedulePin, 400);
  setTimeout(schedulePin, 1200);

  // Watch for typeahead list inject / result class
  try {
    const mo = new MutationObserver((mutations) => {
      let relevant = false;
      for (const m of mutations) {
        if (m.type === 'childList') {
          relevant = true;
          break;
        }
        if (m.type === 'attributes' && (m.attributeName === 'class' || m.attributeName === 'style')) {
          relevant = true;
          break;
        }
      }
      if (relevant) schedulePin();
    });
    mo.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style'],
    });
  } catch (_) {
    /* ignore */
  }

  document.addEventListener('focusin', (e) => {
    if (e.target && e.target.closest && e.target.closest('.app-search, .typeahead__container')) {
      schedulePin();
    }
  });
  document.addEventListener('input', (e) => {
    if (e.target && e.target.closest && e.target.closest('.app-search, .typeahead__container')) {
      schedulePin();
    }
  });
  document.addEventListener('keyup', (e) => {
    if (e.target && e.target.closest && e.target.closest('.app-search, .typeahead__container')) {
      schedulePin();
    }
  });
})();
