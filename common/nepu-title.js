/**
 * Nepu title/season/episode identification — shared by content/tracker.js
 * (Continue Watching title cleanup) and content/subtitles.js (search query
 * building), so both use exactly the same slug/JSON-LD/og:title parsing
 * instead of tracker.js falling back to a raw, unwashed document.title.
 *
 * Loaded as a classic script (see manifest.json content_scripts) before
 * both consumers, so these become plain globals in that isolated world —
 * same pattern as common/store.js's `NVT`.
 */

const QUALITY_TAGS = new Set([
  '4k', 'uhd', 'hd', 'sd', 'cam', 'ts', 'tc', 'scr', 'dvdscr', 'webrip',
  'webdl', 'bluray', 'brrip', 'hdtv', 'dvdrip', 'bdrip', 'remux',
]);

function pad2(n) {
  const x = Number(n) || 0;
  return x < 10 ? `0${x}` : String(x);
}

function formatSeTag(season, episode) {
  if (season == null || episode == null || season === '' || episode === '') return '';
  return `S${pad2(season)}E${pad2(episode)}`;
}

function parseSeasonEpisodeFromText(text) {
  const s = String(text || '');
  let m = s.match(/\b[Ss](\d{1,2})\s*[Ee](\d{1,3})\b/);
  if (m) return { season: Number(m[1]), episode: Number(m[2]) };
  m = s.match(/\b(\d{1,2})\s*[xX]\s*(\d{1,3})\b/);
  if (m) return { season: Number(m[1]), episode: Number(m[2]) };
  m = s.match(/season[-\s]?(\d{1,2})[-\s]?episode[-\s]?(\d{1,3})/i);
  if (m) return { season: Number(m[1]), episode: Number(m[2]) };
  return { season: null, episode: null };
}

function parseSlugTitleYear(slugRaw) {
  let slug = decodeURIComponent(String(slugRaw || '')).replace(/_/g, '-');
  const parts = slug.split('-').filter(Boolean);
  if (!parts.length) return { title: '', year: '' };

  while (parts.length && QUALITY_TAGS.has(parts[0].toLowerCase())) {
    parts.shift();
  }
  while (parts.length && /^\d{5,}$/.test(parts[parts.length - 1])) {
    parts.pop();
  }
  const years = [];
  while (parts.length && /^(19|20)\d{2}$/.test(parts[parts.length - 1])) {
    years.unshift(parts.pop());
  }
  const year = years.length ? years[years.length - 1] : '';
  const title = parts
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return { title: title || '', year: year || '' };
}

function parseNepuSlug(pathname) {
  const path = pathname || location.pathname;

  // Primary TV: /show|tv/{slug}/season/{n}/episode/{n}
  const epPath = path.match(
    /\/(?:show|tv)\/([^/]+)\/season\/(\d+)\/episode\/(\d+)\/?/i
  );
  if (epPath) {
    const { title, year } = parseSlugTitleYear(epPath[1]);
    const season = Number(epPath[2]);
    const episode = Number(epPath[3]);
    const se = formatSeTag(season, episode);
    const query = [title, se].filter(Boolean).join(' ').trim()
      || [title, year].filter(Boolean).join(' ').trim();
    return {
      title: title || '',
      year: year || '',
      season,
      episode,
      kind: 'episode',
      query,
    };
  }

  const m = path.match(/\/(?:movie|tv|watch|anime|show)\/([^/?#]+)/i)
    || path.match(/\/([^/?#]+)\/?$/);
  if (!m) return null;

  const { title, year } = parseSlugTitleYear(m[1]);
  const fromSlugText = parseSeasonEpisodeFromText(m[1]);
  if (!title && !year && fromSlugText.season == null) return null;

  const se = formatSeTag(fromSlugText.season, fromSlugText.episode);
  const query = se
    ? [title, se].filter(Boolean).join(' ').trim()
    : [title, year].filter(Boolean).join(' ').trim();

  const isTvUrl = /\/(?:show|tv)\//i.test(path);
  return {
    title: title || '',
    year: year || '',
    season: fromSlugText.season,
    episode: fromSlugText.episode,
    kind: fromSlugText.season != null ? 'episode' : (isTvUrl ? 'tv' : 'movie'),
    mediaType: (fromSlugText.season != null || isTvUrl) ? 'tv' : 'movie',
    query,
  };
}

function metaContent(sel) {
  const el = document.querySelector(sel);
  return el ? (el.getAttribute('content') || el.textContent || '').trim() : '';
}

function scrapeJsonLdTitle() {
  const scripts = document.querySelectorAll('script[type="application/ld+json"]');
  for (const s of scripts) {
    let data;
    try {
      data = JSON.parse(s.textContent || '');
    } catch (_) {
      continue;
    }
    const nodes = Array.isArray(data) ? data : data['@graph'] ? data['@graph'] : [data];
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      const type = node['@type'];
      const types = Array.isArray(type) ? type : [type];
      if (types.some((t) => /Movie|TVSeries|TVEpisode|VideoObject|CreativeWork/i.test(String(t || '')))) {
        const name = node.name || node.headline || '';
        if (!name) continue;
        const year = String(node.datePublished || node.dateCreated || '')
          .match(/^(19|20)\d{2}/);
        let season = null;
        let episode = null;
        if (node.episodeNumber != null) episode = Number(node.episodeNumber) || null;
        const part = node.partOfSeason;
        if (part && typeof part === 'object') {
          if (part.seasonNumber != null) season = Number(part.seasonNumber) || null;
        }
        if (node.seasonNumber != null) season = Number(node.seasonNumber) || season;
        const seriesName =
          (node.partOfSeries && (node.partOfSeries.name || node.partOfSeries)) || '';
        const showTitle = types.some((t) => /TVEpisode/i.test(String(t || '')))
          && seriesName
          ? String(seriesName).trim()
          : String(name).trim();
        return {
          title: showTitle,
          episodeTitle: String(name).trim(),
          year: year ? year[0] : '',
          season,
          episode,
          imdbId: (node.sameAs || []).concat(node.url || [])
            .map(String)
            .map((u) => (u.match(/imdb\.com\/title\/(tt\d+)/i) || [])[1])
            .filter(Boolean)[0] || '',
        };
      }
    }
  }
  return null;
}

function cleanPageTitle(raw) {
  return String(raw || '')
    .replace(/\s*[|\-–—]\s*Nepu.*$/i, '')
    .replace(/\s+Online\s*(Free)?.*$/i, '')
    .replace(/\s+Watch\s+.*$/i, '')
    .trim();
}

function identifyTitle() {
  const fromSlug = parseNepuSlug(location.pathname);
  const fromLd = scrapeJsonLdTitle();
  const og = cleanPageTitle(metaContent('meta[property="og:title"]'));
  const docTitle = cleanPageTitle(document.title);
  const fromOgSe = parseSeasonEpisodeFromText(og + ' ' + docTitle);

  let title = (fromSlug && fromSlug.title)
    || (fromLd && fromLd.title)
    || og
    || docTitle
    || '';
  let year = (fromSlug && fromSlug.year) || (fromLd && fromLd.year) || '';
  let imdbId = (fromLd && fromLd.imdbId) || '';
  let season =
    (fromSlug && fromSlug.season != null ? fromSlug.season : null)
    ?? (fromLd && fromLd.season != null ? fromLd.season : null)
    ?? fromOgSe.season;
  let episode =
    (fromSlug && fromSlug.episode != null ? fromSlug.episode : null)
    ?? (fromLd && fromLd.episode != null ? fromLd.episode : null)
    ?? fromOgSe.episode;

  if (!year) {
    const ym = (title + ' ' + docTitle).match(/\b((?:19|20)\d{2})\b/);
    if (ym) year = ym[1];
  }

  // Strip SxxExx / years from display title noise
  const cleanTitle = String(title)
    .replace(/\b[Ss]\d{1,2}\s*[Ee]\d{1,3}\b/g, '')
    .replace(/\b\d{1,2}\s*[xX]\s*\d{1,3}\b/g, '')
    .replace(/\b(19|20)\d{2}\b/g, '')
    .replace(/\s+/g, ' ')
    .trim() || title;

  const se = formatSeTag(season, episode);
  const query = se
    ? [cleanTitle, se].filter(Boolean).join(' ').trim()
    : (fromSlug && fromSlug.query)
      || [cleanTitle, year].filter(Boolean).join(' ').trim()
      || cleanTitle;

  return {
    title: cleanTitle || query,
    year,
    query,
    imdbId,
    tmdbId: '',
    season,
    episode,
    kind: season != null && episode != null ? 'episode' : (/\/(?:show|tv)\//i.test(location.pathname) ? 'tv' : 'movie'),
    mediaType: (season != null || (fromSlug && (fromSlug.kind === 'tv' || fromSlug.mediaType === 'tv')) || /\/(?:show|tv)\//i.test(location.pathname)) ? 'tv' : 'movie',
    source: fromSlug && fromSlug.season != null
      ? 'url-slug'
      : fromLd
        ? 'json-ld'
        : fromSlug
          ? 'url-slug'
          : og
            ? 'og:title'
            : 'document.title',
  };
}
