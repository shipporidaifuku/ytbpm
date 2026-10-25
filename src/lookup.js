(function (root) {
  'use strict';

  const DEEZER = 'https://api.deezer.com';
  const NOISE_WORDS =
    /(^|\s)(official\s*(music\s*)?(video|audio|mv|lyric\s*video)?|music\s*video|lyrics?\s*video|lyrics?|audio|mv|pv|hd|hq|4k|full\s*ver(sion)?\.?|remaster(ed)?)(?=\s|$)/gi;

  function cleanArtist(channel) {
    return (channel || '')
      .replace(/\s*-\s*Topic$/i, '')
      .replace(/VEVO$/i, '')
      .replace(/\s*(official\s*(youtube\s*)?channel|official|公式チャンネル|公式|チャンネル|channel)\s*$/i, '')
      .trim();
  }

  function stripNoise(text) {
    return text
      .replace(/[(\[（【［〔][^)\]）】］〕]*[)\]）】］〕]/g, ' ')
      .replace(/\s(feat|ft)\.?\s.*$/i, '')
      .replace(NOISE_WORDS, ' ')
      .replace(NOISE_WORDS, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[\s\-–—/|]+|[\s\-–—/|]+$/g, '')
      .trim();
  }

  function parseTitle(rawTitle, channel) {
    const title = (rawTitle || '').trim();
    const fallbackArtist = cleanArtist(channel);

    const quoted = title.match(/^(.*?)[「『](.+?)[」』]/);
    if (quoted) {
      return { artist: stripNoise(quoted[1]) || fallbackArtist, track: stripNoise(quoted[2]) };
    }

    const dash = title.split(/\s+[-–—]\s+/);
    if (dash.length >= 2) {
      return { artist: stripNoise(dash[0]), track: stripNoise(dash.slice(1).join(' ')) };
    }

    return { artist: fallbackArtist, track: stripNoise(title) };
  }

  function firstCredit(text) {
    return stripNoise(text.split(/\s+[/／×x]\s+|\s*[/／]\s*/)[0]);
  }

  function parseTitleCandidates(rawTitle, channel) {
    const title = (rawTitle || '').trim();
    const primary = parseTitle(title, channel);
    const dash = title.split(/\s+[-–—]\s+/);
    if (title.match(/[「『]/) || dash.length < 2) return [primary];

    const left = dash[0];
    const right = dash.slice(1).join(' ');
    const artistFirst = { artist: firstCredit(left), track: firstCredit(right) };
    const trackFirst = { artist: firstCredit(right), track: firstCredit(left) };
    const channelName = normalize(cleanArtist(channel));
    const mentions = (text) => !!channelName && normalize(text).includes(channelName);
    const ordered =
      mentions(right) && !mentions(left)
        ? [trackFirst, primary, artistFirst]
        : [primary, artistFirst, trackFirst];

    const seen = new Set();
    return ordered.filter((c) => {
      const key = `${c.artist}\u0000${c.track}`;
      if (!c.track || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function buildQueries({ artist, track }) {
    const queries = [];
    if (artist && track) queries.push(`${artist} ${track}`);
    if (track) queries.push(track);
    return queries;
  }

  function normalize(text) {
    return (text || '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/\(.*?\)|\[.*?\]/g, '')
      .replace(/[\s\p{P}\p{S}]/gu, '');
  }

  function isSameTrack(candidate, { track }) {
    const a = normalize(candidate.title);
    const b = normalize(track);
    return !!a && !!b && (a.includes(b) || b.includes(a));
  }

  function isSameArtist(candidate, { artist }) {
    const a = normalize(candidate.artist && candidate.artist.name);
    const b = normalize(artist);
    return !!a && !!b && (a.includes(b) || b.includes(a));
  }

  async function getJson(fetchImpl, url) {
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(json.error.message || 'Deezer API error');
    return json;
  }

  async function lookupBpm(info, fetchImpl) {
    const candidates = [];
    const seen = new Set();
    for (const q of buildQueries(info)) {
      const json = await getJson(fetchImpl, `${DEEZER}/search?limit=5&q=${encodeURIComponent(q)}`);
      for (const t of json.data || []) {
        if (!seen.has(t.id) && isSameTrack(t, info)) {
          seen.add(t.id);
          candidates.push(t);
        }
      }
      if (candidates.length >= 5) break;
    }

    const details = await Promise.all(
      candidates.slice(0, 5).map((t) => getJson(fetchImpl, `${DEEZER}/track/${t.id}`).catch(() => null)),
    );
    const artistIds = new Set();
    if (info.artist) {
      const json = await getJson(fetchImpl, `${DEEZER}/search/artist?limit=3&q=${encodeURIComponent(info.artist)}`)
        .catch(() => ({ data: [] }));
      for (const a of json.data || []) {
        if (isSameArtist({ artist: a }, info)) artistIds.add(a.id);
      }
    }

    const withBpm = details.filter((d) => d && d.bpm > 0);
    const matches = (d) => (d.artist && artistIds.has(d.artist.id)) || isSameArtist(d, info);
    const hit = withBpm.find(matches) || withBpm[0];
    if (!hit) return { found: false };
    return {
      found: true,
      bpm: hit.bpm,
      artist: hit.artist && hit.artist.name,
      title: hit.title,
      link: hit.link,
      artistMatched: matches(hit),
      source: 'Deezer',
    };
  }

  async function lookupBpmFromTitle(rawTitle, channel, fetchImpl) {
    const candidates = parseTitleCandidates(rawTitle, channel);
    for (const info of candidates) {
      const result = await lookupBpm(info, fetchImpl);
      if (result.found) return { ...result, query: info };
    }
    return { found: false, query: candidates[0] };
  }

  const api = { parseTitle, parseTitleCandidates, buildQueries, lookupBpm, lookupBpmFromTitle, cleanArtist };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.YtBpmLookup = api;
  }
})(globalThis);
