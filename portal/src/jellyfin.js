// Thin client for the private media engine (Jellyfin). Customers never talk to it
// directly — every call goes through the portal using that customer's own token,
// so the engine itself enforces which libraries each customer can see.

const BASE = (process.env.JELLYFIN_URL || 'http://jellyfin:8096').replace(/\/$/, '');

function authHeader(deviceId, token) {
  let h = `MediaBrowser Client="Flex", Device="Flex Web", DeviceId="${deviceId}", Version="1.0.0"`;
  if (token) h += `, Token="${token}"`;
  return h;
}

class JFError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

async function jf(method, path, { token, deviceId = 'flex-portal', query, body, raw } = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: authHeader(deviceId, token),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  if (raw) return res;
  if (!res.ok) throw new JFError(res.status, `${method} ${path} -> ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Jellyfin moved several per-user routes in 10.9 (/Users/{id}/Items -> /Items?userId=).
// Try the modern route first and fall back, so the portal works on 10.8 – 10.11.
async function jfFirst(method, paths, opts) {
  let last;
  for (const p of paths) {
    try { return await jf(method, p, opts); } catch (e) {
      last = e;
      if (e.status !== 404 && e.status !== 405) throw e;
    }
  }
  throw last;
}

const FIELDS = 'Overview,Genres,ProductionYear,OfficialRating,CommunityRating,RunTimeTicks,' +
  'UserData,ChildCount,ParentBackdropItemId,ParentBackdropImageTags,SeriesPrimaryImageTag,PrimaryImageAspectRatio';

function slim(i) {
  if (!i) return null;
  const tags = i.ImageTags || {};
  const ud = i.UserData || {};
  return {
    id: i.Id,
    name: i.Name,
    type: i.Type,                       // Movie | Series | Episode | Season | CollectionFolder
    year: i.ProductionYear,
    overview: i.Overview,
    rating: i.OfficialRating,
    score: i.CommunityRating ? Math.round(i.CommunityRating * 10) / 10 : null,
    minutes: i.RunTimeTicks ? Math.round(i.RunTimeTicks / 600000000) : null,
    genres: (i.Genres || []).slice(0, 3),
    poster: tags.Primary ? i.Id : (i.SeriesId && i.SeriesPrimaryImageTag ? i.SeriesId : null),
    thumb: tags.Thumb ? i.Id : null,
    backdrop: (i.BackdropImageTags || []).length ? i.Id
      : ((i.ParentBackdropImageTags || []).length ? i.ParentBackdropItemId : null),
    logo: tags.Logo ? i.Id : null,
    aspect: i.PrimaryImageAspectRatio,
    progress: ud.PlayedPercentage ? Math.round(ud.PlayedPercentage) : 0,
    positionTicks: ud.PlaybackPositionTicks || 0,
    played: !!ud.Played,
    favorite: !!ud.IsFavorite,
    seriesId: i.SeriesId,
    seriesName: i.SeriesName,
    seasonId: i.SeasonId,
    index: i.IndexNumber,
    parentIndex: i.ParentIndexNumber,
    collectionType: i.CollectionType,
    childCount: i.ChildCount,
  };
}

module.exports = { jf, jfFirst, JFError, slim, FIELDS, BASE, authHeader };
