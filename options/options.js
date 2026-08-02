(function () {
  'use strict';

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  const state = { settings: null };

  const trackToggle = document.getElementById('track-toggle');
  const resumeToggle = document.getElementById('resume-toggle');
  const autoApplyToggle = document.getElementById('autoapply-toggle');
  const useTimeToggle = document.getElementById('usetime-toggle');
  const minDurationInput = document.getElementById('min-duration-input');
  const completedRange = document.getElementById('completed-range');
  const completedValueEl = document.getElementById('completed-value');
  const clearHistoryBtn = document.getElementById('clear-history-btn');
  const clearWatchlistBtn = document.getElementById('clear-watchlist-btn');

  async function initSettings() {
    const settings = await NVT.getSettings();
    state.settings = settings;

    trackToggle.checked = !!settings.trackingEnabled;
    resumeToggle.checked = !!settings.resumeEnabled;
    autoApplyToggle.checked = !!settings.autoApplyCaptions;
    useTimeToggle.checked = !!settings.useTimeProgress;
    minDurationInput.value = settings.minDurationSeconds;
    completedRange.value = Math.round((settings.completedThreshold || 0) * 100);
    completedValueEl.textContent = completedRange.value;

    trackToggle.addEventListener('change', async () => {
      state.settings = await NVT.setSettings({ trackingEnabled: trackToggle.checked });
    });
    resumeToggle.addEventListener('change', async () => {
      state.settings = await NVT.setSettings({ resumeEnabled: resumeToggle.checked });
    });
    autoApplyToggle.addEventListener('change', async () => {
      state.settings = await NVT.setSettings({ autoApplyCaptions: autoApplyToggle.checked });
    });
    useTimeToggle.addEventListener('change', async () => {
      state.settings = await NVT.setSettings({ useTimeProgress: useTimeToggle.checked });
    });
    minDurationInput.addEventListener('change', async () => {
      const v = Math.max(0, Math.round(Number(minDurationInput.value) || 0));
      minDurationInput.value = v;
      state.settings = await NVT.setSettings({ minDurationSeconds: v });
    });
    completedRange.addEventListener('input', () => {
      completedValueEl.textContent = completedRange.value;
    });
    completedRange.addEventListener('change', async () => {
      const v = Number(completedRange.value) / 100;
      state.settings = await NVT.setSettings({ completedThreshold: v });
    });
  }

  clearHistoryBtn.addEventListener('click', async () => {
    if (!confirm('Clear ALL watch history? This cannot be undone.')) return;
    await NVT.clearHistory();
    alert('Watch history cleared.');
  });

  clearWatchlistBtn.addEventListener('click', async () => {
    if (!confirm('Clear the entire watchlist? This cannot be undone.')) return;
    const items = await NVT.listWatchlist();
    await Promise.all(items.map((item) => NVT.removeWatchlist(item.id)));
    alert('Watchlist cleared.');
  });

  // -------------------------------------------------------------------
  // OpenSubtitles / TMDB API keys + login (used by content/subtitles.js
  // on nepu.to/.is/.net, stored via NVT.getSubtitleAuth/setSubtitleAuth
  // so one save here works across all three mirrors).
  // -------------------------------------------------------------------
  const osKeyInput = document.getElementById('os-key-input');
  const osKeySaveBtn = document.getElementById('os-key-save-btn');
  const tmdbKeyInput = document.getElementById('tmdb-key-input');
  const tmdbKeySaveBtn = document.getElementById('tmdb-key-save-btn');
  const subAuthStatusEl = document.getElementById('sub-auth-status');

  function setSubAuthStatus(message, kind) {
    subAuthStatusEl.textContent = message;
    subAuthStatusEl.style.color =
      kind === 'error' ? '#fca5a5' : kind === 'ok' ? '#8dffb0' : '';
  }

  async function refreshSubAuthStatus() {
    const auth = await NVT.getSubtitleAuth();
    const bits = [
      auth.osApiKey ? 'OS key saved' : 'No OpenSubtitles API key',
      auth.tmdbApiKey ? 'TMDB key saved' : 'No TMDB key',
    ];
    setSubAuthStatus(bits.join(' · '), auth.osApiKey ? 'ok' : 'warn');
  }

  osKeySaveBtn.addEventListener('click', async () => {
    const key = osKeyInput.value.trim();
    if (!key) {
      setSubAuthStatus('Paste your OpenSubtitles API key first.', 'error');
      return;
    }
    await NVT.setSubtitleAuth({ osApiKey: key });
    osKeyInput.value = '';
    setSubAuthStatus('OpenSubtitles API key saved.', 'ok');
    refreshSubAuthStatus();
  });

  tmdbKeySaveBtn.addEventListener('click', async () => {
    const key = tmdbKeyInput.value.trim();
    if (!key) {
      setSubAuthStatus('Paste your TMDB API key first.', 'error');
      return;
    }
    await NVT.setSubtitleAuth({ tmdbApiKey: key });
    tmdbKeyInput.value = '';
    setSubAuthStatus('TMDB API key saved.', 'ok');
    refreshSubAuthStatus();
  });

  refreshSubAuthStatus().catch((err) => {
    console.error('[Nepu Watch Tracker] subtitle auth status failed:', err);
  });

  initSettings().catch((err) => {
    console.error('[Nepu Watch Tracker] options init failed:', err);
  });
})();
