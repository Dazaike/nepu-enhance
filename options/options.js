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
  const modernUiToggle = document.getElementById('modernui-toggle');
  const dropboxAutoSyncToggle = document.getElementById('dropbox-autosync-toggle');
  const relTrackToggle = document.getElementById('rel-track-toggle');
  const relNotifToggle = document.getElementById('rel-notif-toggle');
  const relIntervalSelect = document.getElementById('rel-interval-select');
  const recEnabledToggle = document.getElementById('rec-enabled-toggle');
  const recIntervalSelect = document.getElementById('rec-interval-select');
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
    modernUiToggle.checked = settings.nepuModernUi !== false;
    dropboxAutoSyncToggle.checked = settings.dropboxAutoSync !== false;
    relTrackToggle.checked = !!settings.releaseTrackingEnabled;
    relNotifToggle.checked = !!settings.desktopNotificationsEnabled;
    relIntervalSelect.value = String(settings.releaseCheckIntervalHours || 12);
    recEnabledToggle.checked = settings.recommendationsEnabled !== false;
    recIntervalSelect.value = String(settings.recommendationsCheckIntervalHours || 24);
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
    modernUiToggle.addEventListener('change', async () => {
      state.settings = await NVT.setSettings({ nepuModernUi: modernUiToggle.checked });
    });
    dropboxAutoSyncToggle.addEventListener('change', async () => {
      state.settings = await NVT.setSettings({ dropboxAutoSync: dropboxAutoSyncToggle.checked });
    });
    relTrackToggle.addEventListener('change', async () => {
      state.settings = await NVT.setSettings({ releaseTrackingEnabled: relTrackToggle.checked });
      chrome.runtime.sendMessage({ type: 'UPDATE_RELEASE_ALARM' });
    });
    relNotifToggle.addEventListener('change', async () => {
      state.settings = await NVT.setSettings({ desktopNotificationsEnabled: relNotifToggle.checked });
    });
    relIntervalSelect.addEventListener('change', async () => {
      state.settings = await NVT.setSettings({ releaseCheckIntervalHours: Number(relIntervalSelect.value) });
      chrome.runtime.sendMessage({ type: 'UPDATE_RELEASE_ALARM' });
    });
    recEnabledToggle.addEventListener('change', async () => {
      state.settings = await NVT.setSettings({ recommendationsEnabled: recEnabledToggle.checked });
      chrome.runtime.sendMessage({ type: 'UPDATE_RECOMMENDATIONS_ALARM' });
    });
    recIntervalSelect.addEventListener('change', async () => {
      state.settings = await NVT.setSettings({ recommendationsCheckIntervalHours: Number(recIntervalSelect.value) });
      chrome.runtime.sendMessage({ type: 'UPDATE_RECOMMENDATIONS_ALARM' });
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

  // -------------------------------------------------------------------
  // Dropbox sync — background.js owns token refresh + the actual
  // upload/download (it has the CORS-exempt host_permissions); the
  // OAuth 2.0 PKCE authorize/exchange handshake runs here since
  // chrome.identity works from any extension page, not just background.
  // -------------------------------------------------------------------
  const dropboxRedirectInput = document.getElementById('dropbox-redirect-uri');
  const dropboxCopyRedirectBtn = document.getElementById('dropbox-copy-redirect-btn');
  const dropboxAppKeyInput = document.getElementById('dropbox-appkey-input');
  const dropboxConnectBtn = document.getElementById('dropbox-connect-btn');
  const dropboxDisconnectBtn = document.getElementById('dropbox-disconnect-btn');
  const dropboxSyncNowBtn = document.getElementById('dropbox-sync-now-btn');
  const dropboxStatusEl = document.getElementById('dropbox-status');

  dropboxRedirectInput.value = chrome.identity.getRedirectURL();

  function setDropboxStatus(message, kind) {
    dropboxStatusEl.textContent = message;
    dropboxStatusEl.style.color = kind === 'error' ? '#fca5a5' : kind === 'ok' ? '#8dffb0' : '';
  }

  function base64UrlEncode(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function randomPkceVerifier() {
    const arr = new Uint8Array(32);
    crypto.getRandomValues(arr);
    return base64UrlEncode(arr.buffer);
  }

  async function pkceChallengeFor(verifier) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return base64UrlEncode(digest);
  }

  function requestDropboxSync(force) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'DROPBOX_SYNC', payload: { force: !!force } }, (res) => {
        resolve(res || { ok: false, error: 'No response from the extension background.' });
      });
    });
  }

  async function refreshDropboxStatus() {
    const [auth, sync] = await Promise.all([NVT.getDropboxAuth(), NVT.getSyncStatus()]);
    dropboxAppKeyInput.value = auth.appKey || '';
    const connected = !!auth.refreshToken;
    dropboxDisconnectBtn.disabled = !connected;
    dropboxSyncNowBtn.disabled = !connected;

    const bits = [connected ? 'Connected to Dropbox' : 'Not connected'];
    if (sync.syncing) {
      bits.push('syncing…');
    } else if (sync.lastSyncAt) {
      bits.push(`last synced ${new Date(sync.lastSyncAt).toLocaleString()}`);
    }
    if (sync.lastSyncOk === false && sync.lastSyncError) bits.push(`error: ${sync.lastSyncError}`);
    setDropboxStatus(bits.join(' · '), sync.lastSyncOk === false ? 'error' : connected ? 'ok' : 'warn');
  }

  dropboxCopyRedirectBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(dropboxRedirectInput.value);
      setDropboxStatus('Redirect URI copied.', 'ok');
    } catch (err) {
      dropboxRedirectInput.select();
      document.execCommand('copy');
    }
  });

  dropboxConnectBtn.addEventListener('click', async () => {
    const appKey = dropboxAppKeyInput.value.trim();
    if (!appKey) {
      setDropboxStatus('Paste your Dropbox App key first.', 'error');
      return;
    }
    setDropboxStatus('Opening Dropbox authorization…', 'info');
    try {
      const verifier = randomPkceVerifier();
      const challenge = await pkceChallengeFor(verifier);
      const redirectUri = chrome.identity.getRedirectURL();
      const authUrl = new URL('https://www.dropbox.com/oauth2/authorize');
      authUrl.searchParams.set('client_id', appKey);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('token_access_type', 'offline');
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('code_challenge', challenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');

      const resultUrl = await chrome.identity.launchWebAuthFlow({
        url: authUrl.toString(),
        interactive: true,
      });
      const code = new URL(resultUrl).searchParams.get('code');
      if (!code) throw new Error('Dropbox authorization was cancelled.');

      const tokenResp = await fetch('https://api.dropboxapi.com/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          grant_type: 'authorization_code',
          client_id: appKey,
          redirect_uri: redirectUri,
          code_verifier: verifier,
        }),
      });
      if (!tokenResp.ok) throw new Error(`Dropbox token exchange failed (HTTP ${tokenResp.status}).`);
      const body = await tokenResp.json();
      await NVT.setDropboxAuth({
        appKey,
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        expiresAt: Date.now() + (body.expires_in || 14400) * 1000,
      });
      setDropboxStatus('Connected — running first sync…', 'ok');
      await requestDropboxSync(true);
    } catch (err) {
      setDropboxStatus((err && err.message) || 'Dropbox connection failed.', 'error');
    } finally {
      await refreshDropboxStatus();
    }
  });

  dropboxDisconnectBtn.addEventListener('click', async () => {
    await NVT.clearDropboxAuth();
    setDropboxStatus('Disconnected from Dropbox.', 'ok');
    await refreshDropboxStatus();
  });

  dropboxSyncNowBtn.addEventListener('click', async () => {
    setDropboxStatus('Syncing…', 'info');
    dropboxSyncNowBtn.disabled = true;
    try {
      const res = await requestDropboxSync(true);
      setDropboxStatus(res.ok ? 'Synced just now.' : (res.error || 'Sync failed.'), res.ok ? 'ok' : 'error');
    } finally {
      await refreshDropboxStatus();
    }
  });

  refreshDropboxStatus().catch((err) => {
    console.error('[Nepu Watch Tracker] dropbox status failed:', err);
  });

  // -------------------------------------------------------------------
  // New Release Tracking & Notifications controls
  // -------------------------------------------------------------------
  const relTestNotifBtn = document.getElementById('rel-test-notif-btn');
  const relCheckNowBtn = document.getElementById('rel-check-now-btn');
  const relStatusEl = document.getElementById('rel-status');
  const relOptOutListEl = document.getElementById('rel-optout-list');

  function setReleaseStatusUI(message, kind) {
    relStatusEl.textContent = message;
    relStatusEl.style.color = kind === 'error' ? '#fca5a5' : kind === 'ok' ? '#8dffb0' : '';
  }

  async function renderReleaseOptOutList() {
    const [watchlist, settings] = await Promise.all([NVT.listWatchlist(), NVT.getSettings()]);
    const tvItems = watchlist.filter((w) => w && w.mediaType === 'tv');
    const optOuts = new Set(settings.releaseOptOutIds || []);

    relOptOutListEl.innerHTML = '';
    if (!tvItems.length) {
      const span = document.createElement('span');
      span.className = 'tag-empty';
      span.textContent = 'No TV shows in your Watchlist yet.';
      relOptOutListEl.appendChild(span);
      return;
    }

    tvItems.forEach((item) => {
      const div = document.createElement('div');
      div.className = 'optout-item';

      const curSe = item.season != null && item.episode != null ? `S${item.season} E${item.episode}` : 'Bookmarked';
      const latestSe = item.latestSeason != null && item.latestEpisode != null
        ? ` · Latest: S${item.latestSeason} E${item.episode}${item.hasNewRelease ? ' (NEW)' : ''}`
        : '';

      div.innerHTML = `
        <div class="optout-item-body">
          <div class="optout-item-title">${escapeHtml(item.title || item.url || 'Show')}</div>
          <div class="optout-item-sub">${escapeHtml(curSe)}${escapeHtml(latestSe)}</div>
        </div>
        <label class="switch" title="Enable release tracking for this show">
          <input type="checkbox" class="optout-checkbox" ${!optOuts.has(item.id) ? 'checked' : ''} />
          <span class="switch-slider"></span>
        </label>
      `;

      div.querySelector('.optout-checkbox').addEventListener('change', async (e) => {
        const enabled = e.target.checked;
        const curSettings = await NVT.getSettings();
        const curOptOuts = new Set(curSettings.releaseOptOutIds || []);
        if (enabled) {
          curOptOuts.delete(item.id);
        } else {
          curOptOuts.add(item.id);
        }
        state.settings = await NVT.setSettings({ releaseOptOutIds: Array.from(curOptOuts) });
      });

      relOptOutListEl.appendChild(div);
    });
  }

  async function refreshReleaseStatusUI() {
    const [status, settings] = await Promise.all([NVT.getReleaseStatus(), NVT.getSettings()]);
    const bits = [settings.releaseTrackingEnabled ? 'Release tracking enabled' : 'Release tracking disabled'];
    if (status.checking) {
      bits.push('checking for new episodes…');
    } else if (status.lastCheckAt) {
      bits.push(`last checked ${new Date(status.lastCheckAt).toLocaleString()}`);
      if (status.newReleasesFound) bits.push(`${status.newReleasesFound} new release(s) found!`);
    }
    if (status.lastCheckOk === false && status.lastCheckError) bits.push(`error: ${status.lastCheckError}`);
    setReleaseStatusUI(bits.join(' · '), status.lastCheckOk === false ? 'error' : settings.releaseTrackingEnabled ? 'ok' : 'warn');
    await renderReleaseOptOutList();
  }

  relTestNotifBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'SEND_TEST_NOTIFICATION' }, (res) => {
      if (res && res.ok) {
        setReleaseStatusUI('Test notification sent!', 'ok');
      } else {
        setReleaseStatusUI((res && res.error) || 'Failed to send test notification.', 'error');
      }
    });
  });

  relCheckNowBtn.addEventListener('click', async () => {
    relCheckNowBtn.disabled = true;
    setReleaseStatusUI('Checking TMDB for new releases…', 'info');
    try {
      const res = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'CHECK_RELEASES_NOW' }, resolve);
      });
      if (res && res.ok) {
        setReleaseStatusUI(
          res.newReleasesFound
            ? `Check complete · Found ${res.newReleasesFound} new episode(s)!`
            : 'Check complete · All Watchlist shows up to date.',
          'ok'
        );
      } else {
        setReleaseStatusUI((res && res.error) || 'Release check failed.', 'error');
      }
    } finally {
      relCheckNowBtn.disabled = false;
      await refreshReleaseStatusUI();
    }
  });

  // -------------------------------------------------------------------
  // Discovery rails (TMDB multi-row homepage)
  // -------------------------------------------------------------------
  const recRefreshNowBtn = document.getElementById('rec-refresh-now-btn');
  const recStatusEl = document.getElementById('rec-status');

  function setRecStatusUI(message, kind) {
    recStatusEl.textContent = message;
    recStatusEl.style.color = kind === 'error' ? '#fca5a5' : kind === 'ok' ? '#8dffb0' : '';
  }

  async function refreshRecStatusUI() {
    const [rec, settings] = await Promise.all([NVT.getRecommendations(), NVT.getSettings()]);
    const bits = [settings.recommendationsEnabled !== false ? 'Discovery rails enabled' : 'Discovery rails disabled'];
    if (rec.checking) {
      bits.push('refreshing…');
    } else if (rec.updatedAt) {
      bits.push(`last refreshed ${new Date(rec.updatedAt).toLocaleString()}`);
      const rails = Array.isArray(rec.rails) ? rec.rails : [];
      const itemCount = rails.length
        ? rails.reduce((n, r) => n + ((r && r.items && r.items.length) || 0), 0)
        : (rec.items || []).length;
      const railCount = rails.length || (rec.items && rec.items.length ? 1 : 0);
      bits.push(`${railCount} rail(s) · ${itemCount} poster(s)`);
      if (rec.reason) bits.push(rec.reason);
    }
    if (rec.lastError) bits.push(`error: ${rec.lastError}`);
    setRecStatusUI(bits.join(' · '), rec.lastError ? 'error' : settings.recommendationsEnabled !== false ? 'ok' : 'warn');
  }

  recRefreshNowBtn.addEventListener('click', async () => {
    recRefreshNowBtn.disabled = true;
    setRecStatusUI('Refreshing discovery rails from TMDB…', 'info');
    try {
      const res = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'REFRESH_RECOMMENDATIONS_NOW' }, resolve);
      });
      if (!res || !res.ok) {
        setRecStatusUI((res && res.error) || 'Refresh failed.', 'error');
      }
    } finally {
      recRefreshNowBtn.disabled = false;
      await refreshRecStatusUI();
    }
  });
  refreshRecStatusUI().catch((err) => {
    console.error('[Nepu Watch Tracker] recommendations status init failed:', err);
  });
  refreshReleaseStatusUI().catch((err) => {
    console.error('[Nepu Watch Tracker] release status init failed:', err);
  });
  initSettings().catch((err) => {
    console.error('[Nepu Watch Tracker] options init failed:', err);
  });
})();
