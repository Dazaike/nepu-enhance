/**
 * NEPU_SUB_NET_FETCH: content/subtitles.js cannot reliably cross-origin
 * fetch OpenSubtitles/TMDB from a page's execution context (CORS
 * preflight on custom headers like Api-Key/Authorization is not
 * guaranteed). The service worker has host_permissions for those hosts,
 * which exempts its fetches from CORS entirely.
 *
 * NEPU_SUB_OPEN_OPTIONS: content scripts can't reliably call
 * chrome.runtime.openOptionsPage() themselves, so they ask the background
 * page to do it (used when an OpenSubtitles/TMDB key is missing).
 */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'NEPU_SUB_OPEN_OPTIONS') {
    chrome.runtime.openOptionsPage();
    return false;
  }

  if (!msg || msg.type !== 'NEPU_SUB_NET_FETCH') return false;

  const { method = 'GET', url, headers = {}, body } = msg.request || {};
  fetch(url, { method, headers, body })
    .then(async (resp) => {
      const responseText = await resp.text();
      sendResponse({ ok: true, status: resp.status, responseText });
    })
    .catch((err) => {
      sendResponse({ ok: false, error: String((err && err.message) || err) });
    });
  return true; // keep the message channel open for the async response
});
