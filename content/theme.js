/**
 * Nepu Enhance — theme class toggle + search chrome.
 *
 * - Toggles `nvt-modern-ui` on <html> from settings.
 * - Pins the header search pill (site centers it with left:50%).
 * - Floats typeahead results to document.body with position:fixed so the
 *   hero carousel stacking context cannot cover truncated results.
 */
(function () {
  'use strict';

  // Theme chrome is for the top page only (all_frames is enabled for tracking).
  if (window !== window.top) return;

  function clearPinnedSearchStyles() {
    document.querySelectorAll('.nvt-search-pinned, .nvt-typeahead-float').forEach((el) => {
      el.classList.remove('nvt-search-pinned', 'nvt-typeahead-float');
      if (el.style) el.removeAttribute('style');
    });
  }

  function applyTheme(enabled) {
    if (enabled !== false) {
      document.documentElement.classList.add('nvt-modern-ui');
      if (document.body) document.body.classList.add('nvt-modern-ui');
      pinSearchBar();
      floatTypeaheadLists();
    } else {
      document.documentElement.classList.remove('nvt-modern-ui');
      if (document.body) document.body.classList.remove('nvt-modern-ui');
      clearPinnedSearchStyles();
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

  function viewportTier() {
    const w = window.innerWidth || document.documentElement.clientWidth || 1200;
    if (w <= 640) return 'phone';
    if (w <= 900) return 'tablet';
    return 'desktop';
  }

  /** Move the floating search pill left + up (site centers it mid-header).
   * Offsets scale down on tablet/phone so the pill doesn't sit under the
   * collapsed sidebar gutter or overflow the viewport. */
  function pinSearchBar() {
    if (!document.documentElement.classList.contains('nvt-modern-ui')) return;

    const tier = viewportTier();
    const hostLeft = tier === 'phone' ? '52px' : tier === 'tablet' ? '64px' : '112px';
    const hostTop = tier === 'desktop' ? '6px' : '8px';
    const hostRight = tier === 'desktop' ? 'auto' : '10px';

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
          top: hostTop,
          left: hostLeft,
          right: hostRight,
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
        let width;
        let maxWidth;
        if (tier === 'phone') {
          width = 'calc(100vw - 72px)';
          maxWidth = open ? 'calc(100vw - 72px)' : 'none';
        } else if (tier === 'tablet') {
          width = open ? 'min(420px, calc(100vw - 80px))' : 'min(280px, calc(100vw - 120px))';
          maxWidth = open ? 'calc(100vw - 80px)' : 'none';
        } else {
          width = open ? 'min(480px, 72vw)' : 'min(320px, 44vw)';
          maxWidth = open ? '520px' : 'none';
        }
        setImportant(el, {
          'margin-left': '0px',
          'margin-right': '0px',
          'margin-top': '0px',
          'margin-bottom': '0px',
          width: width,
          'max-width': maxWidth,
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
      const vw = window.innerWidth || 360;
      const inputW = Math.round(r.width) || 0;
      // Phone: nearly full viewport so long titles aren't clipped.
      // Desktop: at least 480px, capped to the viewport.
      const width =
        vw <= 640
          ? Math.min(vw - 16, Math.max(inputW || 200, vw - 24))
          : Math.min(Math.max(inputW || 320, 480), vw - 16);
      let left = Math.round(r.left);
      if (left + width > vw - 8) {
        left = Math.max(8, vw - width - 8);
      }
      const top = Math.round(r.bottom + 6);
      const maxH = Math.max(
        140,
        Math.min(vw <= 640 ? 360 : 560, window.innerHeight - top - 12)
      );

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

  // Apply immediately synchronously so the page never flashes or stays unstyled
  applyTheme(true);

  try {
    chrome.storage.local.get('settings', (res) => {
      const s = res && res.settings;
      const enabled = !s || (s.nepuEnhanceModernUi !== false && s.nepuModernUi !== false && s.netbootModernUi !== false);
      applyTheme(enabled);
    });
  } catch (_) {
    applyTheme(true);
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.settings) return;
      const s = changes.settings.newValue;
      const enabled = !s || (s.nepuEnhanceModernUi !== false && s.nepuModernUi !== false && s.netbootModernUi !== false);
      applyTheme(enabled);
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

  /**
   * Handles automatic tab activation on /search pages when a hash is present
   * (e.g. #series or #movies). Dispatches mouse events, Bootstrap events, and
   * manually toggles active classes on the tab and tab-pane.
   */
  function activateSearchTab(targetHash) {
    const target = String(targetHash || location.hash || '').toLowerCase();
    if (!target) return;
    const key = target.replace(/^#/, '');
    const tab =
      document.getElementById(`${key}-tab`) ||
      document.querySelector(`a.nav-link[href="#${key}"], a[data-toggle="tab"][href="#${key}"], [aria-controls="${key}"]`);
    if (!tab) return;

    // 1. Dispatch real native mouse event sequence
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((type) => {
      tab.dispatchEvent(
        new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          view: window,
        })
      );
    });

    // 2. Direct Bootstrap tab plugin trigger if jQuery/bootstrap exists on page
    try {
      const win = typeof window !== 'undefined' ? window : null;
      if (win && win.$ && typeof win.$(tab).tab === 'function') {
        win.$(tab).tab('show');
      }
    } catch (_) {}

    // 3. Fallback: manual tab and tab-pane class synchronization
    const nav = tab.closest('.nav-tabs, .nav, ul') || tab.parentElement;
    if (nav) {
      nav.querySelectorAll('.nav-link, a, button').forEach((link) => {
        link.classList.remove('active');
        link.setAttribute('aria-selected', 'false');
      });
    }
    tab.classList.add('active');
    tab.setAttribute('aria-selected', 'true');

    const targetPane = document.getElementById(key) || document.querySelector(`.tab-pane#${key}`);
    if (targetPane) {
      const parent = targetPane.parentElement;
      if (parent) {
        parent.querySelectorAll('.tab-pane').forEach((p) => {
          p.classList.remove('active', 'show');
        });
      }
      targetPane.classList.add('active', 'show');
    }
  }

  function checkAndActivateSearchTab() {
    if (!location.pathname.includes('/search') && !document.querySelector('.nav-tabs, #movies-tab, #series-tab')) {
      return;
    }
    const hash = (location.hash || '').toLowerCase();
    if (hash === '#series' || hash === '#movies' || hash === '#episodes') {
      activateSearchTab(hash);
    }
  }

  // Run repeatedly during initial load to beat late DOM hydration/rendering
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      checkAndActivateSearchTab();
      [100, 300, 600, 1200, 2000].forEach((t) => setTimeout(checkAndActivateSearchTab, t));
    });
  } else {
    checkAndActivateSearchTab();
    [100, 300, 600, 1200, 2000].forEach((t) => setTimeout(checkAndActivateSearchTab, t));
  }

  window.addEventListener('hashchange', checkAndActivateSearchTab);
})();
