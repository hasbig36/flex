// Flex customer portal: branded Netflix-style web app + API.
// Access rules come from /data/state.json, written by the Splynx sync service.

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { jf, jfFirst, slim, FIELDS, BASE: JF_BASE, authHeader } = require('./jellyfin');
const live = require('./livetv');

const PORT = Number(process.env.PORT || 8080);
const STATE_FILE = process.env.STATE_FILE || '/data/state.json';
const SESSIONS_FILE = process.env.SESSIONS_FILE || '/data/portal-sessions.json';
const AUTH_MODE = process.env.AUTH_MODE || 'splynx';                 // splynx | local
const SPLYNX_URL = (process.env.SPLYNX_URL || '').replace(/\/$/, '');
const SPLYNX_CUSTOMER_AUTH_PATH = process.env.SPLYNX_CUSTOMER_AUTH_PATH || '/api/2.0/admin/auth/tokens';
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 30);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const COOKIE_SECURE = (process.env.COOKIE_SECURE || 'auto');          // auto | true | false
const LIVE_ALLOWED_HOSTS = (process.env.LIVETV_ALLOWED_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean);

const BRAND = {
  name: process.env.BRAND_NAME || 'Flex',
  tagline: process.env.BRAND_TAGLINE || 'Movies, series and live TV — included with your internet.',
  accent: process.env.BRAND_ACCENT || '#E8A33D',
  logo: process.env.BRAND_LOGO_URL || '',
  support: process.env.BRAND_SUPPORT || '',
  upgradeUrl: process.env.UPGRADE_URL || '',
  loginHint: process.env.LOGIN_HINT ||
    (AUTH_MODE === 'local' ? 'Use your customer login and the access code from your provider.'
      : 'Use the same login and password as your customer portal.'),
};

// ───────────────────────── entitlement state (from sync) ─────────────────────────
let state = { customers: {}, login_index: {} };
let stateMtime = 0;
function refreshState() {
  try {
    const st = fs.statSync(STATE_FILE);
    if (st.mtimeMs !== stateMtime) {
      state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      state.customers ||= {}; state.login_index ||= {};
      stateMtime = st.mtimeMs;
      console.log(`[state] loaded ${Object.keys(state.customers).length} media customers`);
    }
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[state] read failed:', e.message);
  }
}
refreshState();
setInterval(refreshState, 5000).unref();
const customer = (cid) => state.customers[cid];

// ───────────────────────── sessions ─────────────────────────
let sessions = new Map();
try {
  const saved = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
  sessions = new Map(Object.entries(saved));
} catch { /* first start */ }
let saveTimer = null;
function persistSessions() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const tmp = SESSIONS_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(sessions)), { mode: 0o600 });
      fs.renameSync(tmp, SESSIONS_FILE);
    } catch (e) { console.error('[sessions] save failed:', e.message); }
  }, 1000);
}
function readCookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}
function setCookie(req, res, value, maxAgeSec) {
  const secure = COOKIE_SECURE === 'true' || (COOKIE_SECURE === 'auto' &&
    (req.secure || req.headers['x-forwarded-proto'] === 'https'));
  res.setHeader('Set-Cookie',
    `mh_sid=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`);
}

// ───────────────────────── stream limits (live + movies together) ─────────────────────────
const activity = new Map();   // cid -> Map(streamKey -> lastSeenMs)
const STREAM_IDLE_MS = 45000;
function touchStream(cid, key, limit) {
  const now = Date.now();
  let m = activity.get(cid);
  if (!m) activity.set(cid, (m = new Map()));
  for (const [k, t] of m) if (now - t > STREAM_IDLE_MS) m.delete(k);
  if (!m.has(key) && limit > 0 && m.size >= limit) return false;
  m.set(key, now);
  return true;
}
function endStream(cid, key) { activity.get(cid)?.delete(key); }
function activeStreams(cid) {
  const m = activity.get(cid); if (!m) return 0;
  const now = Date.now();
  return [...m.values()].filter((t) => now - t <= STREAM_IDLE_MS).length;
}

// ───────────────────────── login rate limit ─────────────────────────
const attempts = new Map();
function tooManyAttempts(ip) {
  const now = Date.now();
  const a = (attempts.get(ip) || []).filter((t) => now - t < 15 * 60e3);
  attempts.set(ip, a);
  return a.length >= 10;
}
const noteAttempt = (ip) => attempts.get(ip).push(Date.now());

// ───────────────────────── app ─────────────────────────
const app = express();
// Only trust X-Forwarded-For from a proxy on this machine / private Docker network (Caddy),
// so a customer can't fake their address to get past ALLOWED_NETWORKS.
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback, linklocal, uniquelocal');
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

// ───────── network restriction: only customers on your own network ─────────
const net = require('net');
const ALLOWED = (process.env.ALLOWED_NETWORKS || '').split(',').map((x) => x.trim()).filter(Boolean).map((cidr) => {
  const [addr, bits] = cidr.split('/');
  const type = net.isIPv6(addr) ? 'ipv6' : 'ipv4';
  const list = new net.BlockList();
  list.addSubnet(addr, Number(bits ?? (type === 'ipv6' ? 128 : 32)), type);
  return { cidr, list, type };
});
const clientIp = (req) => String(req.ip || '').replace(/^::ffff:/, '');
function allowedIp(ip) {
  if (!ALLOWED.length) return true;
  if (ip === '127.0.0.1' || ip === '::1') return true;            // the server itself
  const type = net.isIPv6(ip) ? 'ipv6' : 'ipv4';
  return ALLOWED.some((a) => a.type === type && a.list.check(ip, type));
}
const blockedLog = new Map();
app.use((req, res, next) => {
  if (req.path === '/healthz') return next();
  const ip = clientIp(req);
  if (allowedIp(ip)) return next();
  const now = Date.now();
  if (!blockedLog.has(ip) || now - blockedLog.get(ip) > 600e3) {       // log each address once per 10 min
    blockedLog.set(ip, now);
    console.log(`[access] blocked ${ip} (not in ALLOWED_NETWORKS)`);
  }
  if (req.path.startsWith('/api/') || req.path.startsWith('/live/') || req.path.startsWith('/stream/')) {
    return res.status(403).json({ error: 'not_on_network', ip });
  }
  const e = (x) => String(x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  res.status(403).type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${e(BRAND.name)}</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#F8F4EE;color:#221D18;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px}
.c{max-width:460px;padding:32px;border-radius:24px;background:rgba(255,255,255,.8);box-shadow:0 12px 34px rgba(92,62,32,.12)}
.m{width:40px;height:40px;border-radius:11px;background:${e(BRAND.accent)};display:grid;place-items:center;margin-bottom:18px}
.m:before{content:"";border-left:13px solid #1B1205;border-top:9px solid transparent;border-bottom:9px solid transparent;margin-left:4px}
h1{font-size:24px;margin:0 0 8px}p{margin:0 0 10px;color:#5A4F45}code{background:#F1EBE2;padding:2px 6px;border-radius:6px}</style></head>
<body><div class="c"><div class="m"></div><h1>${e(BRAND.name)} works on our network only</h1>
<p>Connect to your home internet from us, then open this page again.</p>
<p>Your address: <code>${e(ip)}</code></p>${BRAND.support ? `<p>${e(BRAND.support)}</p>` : ''}</div></body></html>`);
});
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

const screens = (n) => `${n} screen${n === 1 ? '' : 's'}`;
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function auth(req, res, next) {
  const sid = readCookie(req, 'mh_sid');
  const s = sid && sessions.get(sid);
  if (!s || s.expires < Date.now()) return res.status(401).json({ error: 'login_required' });
  const c = customer(s.cid);
  if (!c || !c.active) {
    sessions.delete(sid); persistSessions();
    return res.status(403).json({ error: 'suspended', message: pausedMessage(c) });
  }
  req.sid = sid; req.s = s; req.c = c;
  next();
}

function pausedMessage(c) {
  if (c?.suspended_reason === 'awaiting approval') return 'Your Premium plan is waiting for approval. You can start watching as soon as it is approved.';
  if (c?.suspended_reason === 'no media plan') return 'Your plan no longer includes TV. Contact us to add it back.';
  return 'Your TV access is paused. Please settle your account or contact support.';
}

const userOpts = (req, extra = {}) => ({ token: req.s.jfToken, deviceId: req.s.deviceId, ...extra });

// ── public ──
app.get('/healthz', (req, res) => res.json({ ok: true }));
app.get('/api/brand', (req, res) => res.json(BRAND));

async function verifyWithSplynx(login, password) {
  const r = await fetch(SPLYNX_URL + SPLYNX_CUSTOMER_AUTH_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ auth_type: 'customer', login, password }),
    signal: AbortSignal.timeout(15000),
  });
  if (r.ok) return true;
  if (r.status >= 500) throw new Error('Splynx unavailable (' + r.status + ')');
  return false;
}

app.post('/api/login', wrap(async (req, res) => {
  const ip = req.ip;
  if (tooManyAttempts(ip)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  const login = String(req.body?.login || '').trim();
  const password = String(req.body?.password || '');
  if (!login || !password) return res.status(400).json({ error: 'Enter your login and password.' });
  noteAttempt(ip);

  refreshState();
  const cid = state.login_index[login.toLowerCase()];
  const c = cid && customer(cid);

  let ok = false;
  if (AUTH_MODE === 'local') {
    const want = Buffer.from(String(c?.access_code || '~'.repeat(8)));
    const got = Buffer.from(password.trim().toUpperCase().padEnd(want.length).slice(0, want.length));
    ok = !!c?.access_code && crypto.timingSafeEqual(want, got);
  } else {
    try { ok = await verifyWithSplynx(login, password); } catch (e) {
      console.error('[login] Splynx check failed:', e.message);
      return res.status(503).json({ error: 'Sign-in is temporarily unavailable. Please try again shortly.' });
    }
  }
  if (!ok) return res.status(401).json({ error: 'Wrong login or password.' });
  if (!c) return res.status(403).json({ error: 'Your plan does not include TV yet. Contact us to add it.', upsell: true });
  if (!c.active) return res.status(403).json({ error: pausedMessage(c) });

  const sid = crypto.randomBytes(32).toString('base64url');
  const deviceId = 'mh-' + crypto.createHash('sha256').update(sid).digest('hex').slice(0, 24);
  const r = await jf('POST', '/Users/AuthenticateByName', {
    deviceId, body: { Username: c.jellyfin_username, Pw: c.jellyfin_password },
  });
  sessions.set(sid, {
    cid, deviceId, jfToken: r.AccessToken, jfUserId: r.User.Id,
    created: Date.now(), expires: Date.now() + SESSION_DAYS * 86400e3,
    ua: String(req.headers['user-agent'] || '').slice(0, 120),
  });
  persistSessions();
  attempts.delete(ip);
  setCookie(req, res, sid, SESSION_DAYS * 86400);
  res.json({ ok: true });
}));

app.post('/api/logout', (req, res) => {
  const sid = readCookie(req, 'mh_sid');
  const s = sid && sessions.get(sid);
  if (s) {
    jf('POST', '/Sessions/Logout', { token: s.jfToken, deviceId: s.deviceId }).catch(() => {});
    sessions.delete(sid); persistSessions();
  }
  setCookie(req, res, '', 0);
  res.json({ ok: true });
});

// ── account ──
app.get('/api/me', auth, (req, res) => {
  const c = req.c;
  const pk = state.packages || {};
  res.json({
    name: c.name || c.login,
    login: c.login,
    plans: (c.packages || []).map((p) => pk[p]?.label || p),
    channelGroups: c.channel_groups || [],
    libraries: c.libraries || [],
    maxStreams: c.max_streams,
    activeStreams: activeStreams(req.s.cid),
    upsellMessage: state.upsell?.message || '',
    pendingApproval: (c.pending_approval || []).map((p) => pk[p]?.label || p),
  });
});

// ── movies & series (via the media engine, as the customer) ──
const uid = (req) => req.s.jfUserId;
const itemsRoutes = (req) => [`/Items`, `/Users/${uid(req)}/Items`];

async function latest(req, parentId, limit = 18) {
  const r = await jfFirst('GET', [`/Items/Latest`, `/Users/${uid(req)}/Items/Latest`],
    userOpts(req, { query: { userId: uid(req), parentId, limit, fields: FIELDS, enableImageTypes: 'Primary,Backdrop,Thumb,Logo' } }));
  return (r || []).map(slim);
}

app.get('/api/home', auth, wrap(async (req, res) => {
  const views = await jfFirst('GET', [`/UserViews`, `/Users/${uid(req)}/Views`], userOpts(req, { query: { userId: uid(req) } }));
  const libs = (views?.Items || []).filter((v) => ['movies', 'tvshows', 'homevideos', 'mixed', undefined, null].includes(v.CollectionType));

  const [resume, nextUp, ...latestRows] = await Promise.all([
    jfFirst('GET', [`/UserItems/Resume`, `/Users/${uid(req)}/Items/Resume`],
      userOpts(req, { query: { userId: uid(req), limit: 16, mediaTypes: 'Video', fields: FIELDS } })).catch(() => null),
    jf('GET', '/Shows/NextUp', userOpts(req, { query: { userId: uid(req), limit: 16, fields: FIELDS } })).catch(() => null),
    ...libs.map((l) => latest(req, l.Id).catch(() => [])),
  ]);

  const rows = [];
  const cont = (resume?.Items || []).map(slim);
  if (cont.length) rows.push({ id: 'continue', title: 'Continue watching', kind: 'landscape', items: cont });
  const nu = (nextUp?.Items || []).map(slim).filter((i) => !cont.some((c) => c.id === i.id));
  if (nu.length) rows.push({ id: 'nextup', title: 'Next episode', kind: 'landscape', items: nu });
  libs.forEach((l, i) => {
    if (latestRows[i]?.length) rows.push({ id: 'lib-' + l.Id, title: 'New in ' + l.Name, kind: 'poster', libraryId: l.Id, items: latestRows[i] });
  });

  // hero: a recent title with artwork
  const pool = latestRows.flat().filter((i) => i.backdrop && i.overview && i.type !== 'Episode');
  const hero = pool.length ? pool[Math.floor(Math.random() * Math.min(pool.length, 8))] : null;

  res.json({ hero, rows, libraries: libs.map((l) => ({ id: l.Id, name: l.Name, type: l.CollectionType })) });
}));

app.get('/api/browse', auth, wrap(async (req, res) => {
  const { parentId, genre, sort = 'DateCreated', start = 0, type } = req.query;
  const order = sort === 'SortName' ? 'Ascending' : 'Descending';
  const r = await jfFirst('GET', itemsRoutes(req), userOpts(req, {
    query: {
      userId: uid(req), parentId, recursive: true, genres: genre,
      includeItemTypes: type || 'Movie,Series', sortBy: sort + ',SortName', sortOrder: order,
      startIndex: Number(start) || 0, limit: 60, fields: FIELDS, enableTotalRecordCount: true,
    },
  }));
  let genres = [];
  if (parentId && !Number(start)) {
    const g = await jfFirst('GET', ['/Genres'], userOpts(req, { query: { userId: uid(req), parentId, limit: 40 } })).catch(() => null);
    genres = (g?.Items || []).map((x) => x.Name);
  }
  res.json({ items: (r?.Items || []).map(slim), total: r?.TotalRecordCount || 0, genres });
}));

app.get('/api/search', auth, wrap(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 80);
  if (q.length < 2) return res.json({ items: [], channels: [] });
  const r = await jfFirst('GET', itemsRoutes(req), userOpts(req, {
    query: { userId: uid(req), searchTerm: q, recursive: true, includeItemTypes: 'Movie,Series,Episode', limit: 40, fields: FIELDS },
  }));
  const ql = q.toLowerCase();
  const chans = live.all().filter((c) => c.name.toLowerCase().includes(ql)).slice(0, 12).map((c) => channelView(req, c));
  res.json({ items: (r?.Items || []).map(slim), channels: chans.filter((c) => !c.locked || showLocked()) });
}));

app.get('/api/item/:id', auth, wrap(async (req, res) => {
  const id = req.params.id;
  const item = await jfFirst('GET', [`/Items/${id}`, `/Users/${uid(req)}/Items/${id}`],
    userOpts(req, { query: { userId: uid(req), fields: FIELDS + ',People,Studios,Taglines' } }));
  const out = slim(item);
  out.cast = (item.People || []).filter((p) => p.Type === 'Actor').slice(0, 8).map((p) => p.Name);
  out.directors = (item.People || []).filter((p) => p.Type === 'Director').map((p) => p.Name);
  out.tagline = (item.Taglines || [])[0];
  out.allGenres = item.Genres || [];

  const jobs = [jf('GET', `/Items/${id}/Similar`, userOpts(req, { query: { userId: uid(req), limit: 12, fields: FIELDS } })).catch(() => null)];
  if (item.Type === 'Series') {
    jobs.push(jf('GET', `/Shows/${id}/Seasons`, userOpts(req, { query: { userId: uid(req), fields: 'ChildCount' } })));
    jobs.push(jf('GET', '/Shows/NextUp', userOpts(req, { query: { userId: uid(req), seriesId: id, limit: 1, fields: FIELDS } })).catch(() => null));
  }
  const [similar, seasons, nextUp] = await Promise.all(jobs);
  out.similar = (similar?.Items || []).map(slim);
  if (seasons) out.seasons = (seasons.Items || []).map((s) => ({ id: s.Id, name: s.Name, index: s.IndexNumber }));
  if (nextUp?.Items?.[0]) out.nextUp = slim(nextUp.Items[0]);
  res.json(out);
}));

app.get('/api/series/:id/episodes', auth, wrap(async (req, res) => {
  const r = await jf('GET', `/Shows/${req.params.id}/Episodes`, userOpts(req, {
    query: { userId: uid(req), seasonId: req.query.season, fields: FIELDS },
  }));
  res.json({ items: (r?.Items || []).map(slim) });
}));

app.post('/api/item/:id/favorite', auth, wrap(async (req, res) => {
  const on = !!req.body?.on;
  await jfFirst(on ? 'POST' : 'DELETE', [`/UserFavoriteItems/${req.params.id}`, `/Users/${uid(req)}/FavoriteItems/${req.params.id}`],
    userOpts(req, { query: { userId: uid(req) } }));
  res.json({ ok: true });
}));

app.get('/api/img/:id', auth, wrap(async (req, res) => {
  const type = ['Primary', 'Backdrop', 'Logo', 'Thumb'].includes(req.query.type) ? req.query.type : 'Primary';
  const w = Math.min(Number(req.query.w) || 400, 1920);
  const r = await jf('GET', `/Items/${encodeURIComponent(req.params.id)}/Images/${type}`, {
    raw: true, token: req.s.jfToken, deviceId: req.s.deviceId, query: { maxWidth: w, quality: 85 },
  });
  if (!r.ok) return res.status(r.status === 404 ? 404 : 502).end();
  res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  Readable.fromWeb(r.body).pipe(res);
}));

// Start playback: ask the engine for an HLS stream it will remux/transcode for the browser.
const DEVICE_PROFILE = {
  MaxStreamingBitrate: 40000000,
  MaxStaticBitrate: 40000000,
  DirectPlayProfiles: [],
  TranscodingProfiles: [{
    Container: 'ts', Type: 'Video', AudioCodec: 'aac,mp3', VideoCodec: 'h264',
    Context: 'Streaming', Protocol: 'hls', MaxAudioChannels: '2', MinSegments: 1, BreakOnNonKeyFrames: true,
  }],
  ContainerProfiles: [], CodecProfiles: [],
  SubtitleProfiles: [{ Format: 'vtt', Method: 'External' }],
};

app.post('/api/play/:id', auth, wrap(async (req, res) => {
  const id = req.params.id;
  if (!touchStream(req.s.cid, 'vod:' + req.sid, req.c.max_streams)) {
    return res.status(429).json({ error: `Your plan allows ${screens(req.c.max_streams)} at once, and they're all in use. Stop watching on another device, or upgrade your plan.` });
  }
  const info = await jf('POST', `/Items/${id}/PlaybackInfo`, userOpts(req, {
    query: { userId: uid(req) },
    body: {
      UserId: uid(req), DeviceProfile: DEVICE_PROFILE, AutoOpenLiveStream: true,
      EnableDirectPlay: false, EnableDirectStream: false, EnableTranscoding: true,
      AllowVideoStreamCopy: true, AllowAudioStreamCopy: true, MaxStreamingBitrate: 40000000,
      AudioStreamIndex: req.body?.audio, SubtitleStreamIndex: -1,
    },
  }));
  const src = info?.MediaSources?.[0];
  if (!src?.TranscodingUrl) return res.status(415).json({ error: 'This title cannot be played in the browser.' });
  const u = new URL(src.TranscodingUrl, 'http://x');
  u.searchParams.delete('api_key'); u.searchParams.delete('ApiKey');
  const subs = (src.MediaStreams || []).filter((s) => s.Type === 'Subtitle' && s.DeliveryUrl).map((s) => {
    const su = new URL(s.DeliveryUrl, 'http://x'); su.searchParams.delete('api_key'); su.searchParams.delete('ApiKey');
    return { label: s.DisplayTitle || s.Language || 'Subtitles', lang: s.Language || '', url: '/stream' + su.pathname + su.search };
  });
  const audio = (src.MediaStreams || []).filter((s) => s.Type === 'Audio').map((s) => ({ index: s.Index, label: s.DisplayTitle }));
  const item = slim(await jfFirst('GET', [`/Items/${id}`, `/Users/${uid(req)}/Items/${id}`],
    userOpts(req, { query: { userId: uid(req), fields: FIELDS } })));
  res.json({
    url: '/stream' + u.pathname + u.search,
    playSessionId: info.PlaySessionId, mediaSourceId: src.Id,
    startSeconds: item.positionTicks && !item.played ? Math.floor(item.positionTicks / 1e7) : 0,
    durationSeconds: src.RunTimeTicks ? src.RunTimeTicks / 1e7 : null,
    subtitles: subs, audio, item,
  });
}));

app.post('/api/progress', auth, wrap(async (req, res) => {
  const { itemId, seconds = 0, paused = false, event = 'progress', playSessionId, mediaSourceId } = req.body || {};
  const body = {
    ItemId: itemId, MediaSourceId: mediaSourceId, PlaySessionId: playSessionId,
    PositionTicks: Math.max(0, Math.floor(Number(seconds) * 1e7)), IsPaused: !!paused, PlayMethod: 'Transcode',
    CanSeek: true,
  };
  const p = event === 'start' ? '/Sessions/Playing' : event === 'stop' ? '/Sessions/Playing/Stopped' : '/Sessions/Playing/Progress';
  await jf('POST', p, userOpts(req, { body })).catch(() => {});
  if (event === 'stop') {
    endStream(req.s.cid, 'vod:' + req.sid);
    jf('DELETE', '/Videos/ActiveEncodings', userOpts(req, { query: { deviceId: req.s.deviceId, playSessionId } })).catch(() => {});
  } else if (!paused) {
    touchStream(req.s.cid, 'vod:' + req.sid, 0);
  }
  res.json({ ok: true });
}));

// Pass-through for HLS playlists/segments/subtitles. Token is added here, server-side.
app.get(/^\/stream\/((?:videos|audio)\/.+)$/i, auth, wrap(async (req, res) => {
  const url = new URL(JF_BASE + '/' + req.params[0]);
  for (const [k, v] of Object.entries(req.query)) if (!/^api_?key$/i.test(k)) url.searchParams.set(k, v);
  url.searchParams.set('api_key', req.s.jfToken);
  if (/\.(ts|mp4|m4s|aac)$/i.test(url.pathname)) touchStream(req.s.cid, 'vod:' + req.sid, 0);
  await pipe(url, req, res, { Authorization: authHeader(req.s.deviceId, req.s.jfToken) });
}));

async function pipe(url, req, res, headers = {}) {
  const ac = new AbortController();
  req.on('close', () => ac.abort());
  const h = { ...headers };
  if (req.headers.range) h.Range = req.headers.range;
  let r;
  try { r = await fetch(url, { headers: h, signal: ac.signal, redirect: 'follow' }); } catch (e) {
    if (!res.headersSent) res.status(502).end(); return;
  }
  res.status(r.status);
  for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
    const v = r.headers.get(k); if (v) res.setHeader(k, v);
  }
  res.setHeader('Cache-Control', 'no-store');
  if (!r.body) return res.end();
  Readable.fromWeb(r.body).on('error', () => res.destroy()).pipe(res);
}

// ── live TV ──
const showLocked = () => state.upsell?.show_locked_channels !== false;
const canWatch = (c, ch) => (c.channel_groups || []).some((g) => g.toLowerCase() === ch.group.toLowerCase());
function channelView(req, ch) {
  const { now, next } = live.nowNext(ch);
  return {
    id: ch.id, name: ch.name, number: ch.number, group: ch.group,
    logo: ch.logo ? `/api/live/logo/${ch.id}` : null,
    locked: !canWatch(req.c, ch), now, next,
  };
}

app.get('/api/live/channels', auth, (req, res) => {
  const list = live.all().map((ch) => channelView(req, ch)).filter((c) => !c.locked || showLocked());
  const groups = [...new Set(list.map((c) => c.group))];
  res.json({ channels: list, groups });
});

app.get('/api/live/guide', auth, (req, res) => {
  const from = Date.now() - 30 * 60e3;
  const hours = Math.min(Number(req.query.hours) || 6, 24);
  const to = from + hours * 3600e3;
  const list = live.all().filter((ch) => canWatch(req.c, ch) || showLocked()).map((ch) => ({
    ...channelView(req, ch), programmes: live.programmes(ch, from, to),
  }));
  res.json({ from, to, channels: list });
});

app.get('/api/live/logo/:id', auth, wrap(async (req, res) => {
  const ch = live.get(req.params.id);
  if (!ch?.logo) return res.status(404).end();
  if (!/^https?:/i.test(ch.logo)) return res.status(404).end();
  const r = await fetch(ch.logo, { signal: AbortSignal.timeout(10000) }).catch(() => null);
  if (!r?.ok) return res.status(404).end();
  res.setHeader('Content-Type', r.headers.get('content-type') || 'image/png');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  Readable.fromWeb(r.body).pipe(res);
}));

function liveGuard(req, res) {
  const ch = live.get(req.params.id);
  if (!ch) { res.status(404).json({ error: 'Channel not found' }); return null; }
  if (!canWatch(req.c, ch)) { res.status(403).json({ error: state.upsell?.message || 'Not in your plan.', locked: true }); return null; }
  if (!touchStream(req.s.cid, 'live:' + req.sid, req.c.max_streams)) {
    res.status(429).json({ error: `Your plan allows ${screens(req.c.max_streams)} at once, and they're all in use. Stop watching on another device, or upgrade your plan.` });
    return null;
  }
  return ch;
}

app.get('/api/live/:id/play', auth, (req, res) => {
  const ch = liveGuard(req, res); if (!ch) return;
  res.json({
    kind: ch.kind,
    url: ch.kind === 'hls' ? `/live/${ch.id}/index.m3u8` : `/live/${ch.id}/stream.ts`,
    channel: channelView(req, ch),
  });
});

app.post('/api/live/:id/stop', auth, (req, res) => { endStream(req.s.cid, 'live:' + req.sid); res.json({ ok: true }); });

const b64 = (s) => Buffer.from(s).toString('base64url');
const unb64 = (s) => Buffer.from(String(s || ''), 'base64url').toString('utf8');

function hostAllowed(ch, u) {
  try { const h = new URL(u).host; return ch.hosts.has(h) || LIVE_ALLOWED_HOSTS.includes(h); } catch { return false; }
}

async function sendPlaylist(ch, upstream, req, res) {
  const r = await fetch(upstream, { signal: AbortSignal.timeout(15000), redirect: 'follow' }).catch(() => null);
  if (!r?.ok) return res.status(502).send('#EXTM3U\n# upstream unavailable');
  ch.hosts.add(new URL(r.url).host);             // follow CDN redirects
  const base = r.url;
  const text = await r.text();
  const rw = (uri) => {
    const abs = new URL(uri, base).toString();
    const isList = /\.m3u8(\?|$)/i.test(new URL(abs).pathname + '?');
    return `/live/${ch.id}/${isList ? 'p' : 's'}/${b64(abs)}`;
  };
  const out = text.split(/\r?\n/).map((line) => {
    const l = line.trim();
    if (!l) return line;
    if (l.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${rw(u)}"`);
    return rw(l);
  }).join('\n');
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Cache-Control', 'no-store');
  res.send(out);
}

app.get('/live/:id/index.m3u8', auth, wrap(async (req, res) => {
  const ch = liveGuard(req, res); if (!ch) return;
  await sendPlaylist(ch, ch.url, req, res);
}));
app.get('/live/:id/p/:u', auth, wrap(async (req, res) => {
  const ch = liveGuard(req, res); if (!ch) return;
  const u = unb64(req.params.u);
  if (!hostAllowed(ch, u)) return res.status(403).end();
  await sendPlaylist(ch, u, req, res);
}));
app.get('/live/:id/s/:u', auth, wrap(async (req, res) => {
  const ch = liveGuard(req, res); if (!ch) return;
  const u = unb64(req.params.u);
  if (!hostAllowed(ch, u)) return res.status(403).end();
  await pipe(u, req, res);
}));
app.get('/live/:id/stream.ts', auth, wrap(async (req, res) => {
  const ch = liveGuard(req, res); if (!ch) return;
  const keep = setInterval(() => touchStream(req.s.cid, 'live:' + req.sid, 0), 20000);
  res.on('close', () => { clearInterval(keep); endStream(req.s.cid, 'live:' + req.sid); });
  await pipe(ch.url, req, res);
}));


// ───────── director approvals (Premium needs the director's OK) ─────────
const DIRECTOR_PASSWORD = process.env.DIRECTOR_PASSWORD || '';
const DIRECTOR_NAME = process.env.DIRECTOR_NAME || 'Director';
const APPROVALS_FILE = process.env.APPROVALS_FILE || path.join(path.dirname(STATE_FILE), 'approvals.json');
const APPROVALS_LOG = APPROVALS_FILE.replace(/\.json$/, '') + '-log.jsonl';
const dirSessions = new Map();
const sha = (x) => crypto.createHash('sha256').update(String(x)).digest();
function readApprovals() {
  try { return JSON.parse(fs.readFileSync(APPROVALS_FILE, 'utf8')) || {}; } catch { return {}; }
}
function writeApprovals(obj) {
  const tmp = APPROVALS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1), { mode: 0o640 });
  fs.renameSync(tmp, APPROVALS_FILE);
}
function directorAuth(req, res, next) {
  const sid = readCookie(req, 'flex_dir');
  const s = sid && dirSessions.get(sid);
  if (!s || s.expires < Date.now()) return res.status(401).json({ error: 'login_required' });
  s.expires = Date.now() + 12 * 3600e3;
  next();
}
app.get('/director', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'director.html')));
app.post('/api/director/login', (req, res) => {
  const ip = req.ip;
  if (!DIRECTOR_PASSWORD) return res.status(503).json({ error: 'The director password is not set on the server (DIRECTOR_PASSWORD).' });
  if (tooManyAttempts('dir:' + ip)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  noteAttempt('dir:' + ip);
  if (!crypto.timingSafeEqual(sha(req.body?.password || ''), sha(DIRECTOR_PASSWORD))) {
    console.log(`[director] failed sign-in from ${ip}`);
    return res.status(401).json({ error: 'Wrong password.' });
  }
  attempts.delete('dir:' + ip);
  const sid = crypto.randomBytes(32).toString('base64url');
  dirSessions.set(sid, { expires: Date.now() + 12 * 3600e3 });
  const secure = COOKIE_SECURE === 'true' || (COOKIE_SECURE === 'auto' && (req.secure || req.headers['x-forwarded-proto'] === 'https'));
  res.setHeader('Set-Cookie', `flex_dir=${sid}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${secure ? '; Secure' : ''}`);
  console.log(`[director] signed in from ${ip}`);
  res.json({ ok: true, name: DIRECTOR_NAME });
});
app.post('/api/director/logout', (req, res) => {
  dirSessions.delete(readCookie(req, 'flex_dir'));
  res.setHeader('Set-Cookie', 'flex_dir=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
  res.json({ ok: true });
});
app.get('/api/director/requests', directorAuth, (req, res) => {
  refreshState();
  const decisions = readApprovals();
  const live = Object.values(state.approval_requests || {});
  const liveKeys = new Set(live.map((r) => r.key));
  const waiting = live.filter((r) => !decisions[r.key] || decisions[r.key].decision !== 'rejected')
    .filter((r) => !decisions[r.key]).sort((a, b) => String(a.first_seen).localeCompare(String(b.first_seen)));
  const rejected = live.filter((r) => decisions[r.key]?.decision === 'rejected').map((r) => ({ ...r, ...decisions[r.key] }));
  // approved ones: no longer in approval_requests (they're active); show from decisions
  const approved = Object.entries(decisions).filter(([, d]) => d.decision === 'approved')
    .map(([key, d]) => ({ key, ...d, stillActive: !liveKeys.has(key) }))
    .sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 100);
  res.json({ director: DIRECTOR_NAME, splynxUrl: SPLYNX_URL, lastSync: state.last_sync?.at || null, waiting, rejected, approved });
});
app.post('/api/director/decide', directorAuth, (req, res) => {
  const { key, decision, note } = req.body || {};
  if (!['approved', 'rejected'].includes(decision)) return res.status(400).json({ error: 'Choose approve or reject.' });
  const decisions = readApprovals();
  const r = (state.approval_requests || {})[key];
  if (!r && !decisions[key]) return res.status(404).json({ error: 'This request no longer exists. The service may have been removed in Splynx.' });
  const info = r ? { customer_id: r.customer_id, login: r.login, name: r.name, package_label: r.package_label, tariff: r.tariff, service_id: r.service_id }
    : { customer_id: decisions[key].customer_id, login: decisions[key].login, name: decisions[key].name, package_label: decisions[key].package_label, tariff: decisions[key].tariff, service_id: decisions[key].service_id };
  const entry = { decision, by: DIRECTOR_NAME, at: new Date().toISOString(), note: String(note || '').slice(0, 300), ip: req.ip, ...info };
  decisions[key] = entry;
  writeApprovals(decisions);
  fs.appendFile(APPROVALS_LOG, JSON.stringify({ key, ...entry }) + '\n', () => {});
  console.log(`[director] ${decision} ${info.package_label} for ${info.login} (service ${info.service_id})`);
  res.json({ ok: true });
});

// ── operator status (for your NOC / monitoring) ──
app.get('/api/admin/status', (req, res) => {
  const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!ADMIN_TOKEN || tok.length !== ADMIN_TOKEN.length ||
      !crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(ADMIN_TOKEN))) return res.status(401).end();
  const custs = Object.values(state.customers);
  let streams = 0; for (const cid of activity.keys()) streams += activeStreams(cid);
  res.json({
    lastSync: state.last_sync || null,
    customers: { total: custs.length, active: custs.filter((c) => c.active).length },
    sessions: sessions.size, activeStreams: streams, live: live.status(),
  });
});

// ── installable app ──
// The web app installs from the browser (manifest below). The Android app (phones and
// Android TV) is an APK the operator drops in APP_DIR; customers download it from "Get the app".
const APP_DIR = process.env.APP_DIR || '/data/app';
const APK_FILE = path.join(APP_DIR, 'flex.apk');
app.get('/manifest.webmanifest', (req, res) => {
  res.type('application/manifest+json').json({
    name: BRAND.name, short_name: BRAND.name, description: BRAND.tagline,
    id: '/', start_url: '/', scope: '/', display: 'standalone', orientation: 'any',
    background_color: '#F8F4EE', theme_color: '#F8F4EE',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
    ],
  });
});
app.get(['/app', '/get'], (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'get.html')));
app.get('/api/app', (req, res) => {
  let android = null;
  try { const st = fs.statSync(APK_FILE); android = { url: '/download/flex.apk', size: st.size, updated: st.mtime.toISOString() }; } catch { /* no APK yet */ }
  res.json({ android });
});
app.get('/download/flex.apk', (req, res) => {
  if (!fs.existsSync(APK_FILE)) return res.status(404).type('text').send('The Android app is not available yet.');
  res.download(APK_FILE, `${BRAND.name.replace(/[^\w-]+/g, '') || 'Flex'}.apk`, { headers: { 'Content-Type': 'application/vnd.android.package-archive' } });
});

// ── web app ──
const PUB = path.join(__dirname, '..', 'public');
app.use(express.static(PUB, { index: false, maxAge: '1h' }));
app.get(/^\/(?!api\/|live\/|stream\/).*/, (req, res) => res.sendFile(path.join(PUB, 'index.html')));

app.use((err, req, res, next) => {
  const status = err.status === 401 ? 401 : err.status === 403 || err.status === 404 ? err.status : 500;
  if (status === 401) { // engine token expired/revoked — make the customer sign in again
    sessions.delete(req.sid); persistSessions();
  }
  console.error(`[error] ${req.method} ${req.path}:`, err.message);
  if (!res.headersSent) res.status(status).json({ error: status === 404 ? 'Not found' : status === 401 ? 'login_required' : 'Something went wrong. Please try again.' });
});

// tidy expired sessions daily
setInterval(() => {
  const now = Date.now(); let n = 0;
  for (const [k, s] of sessions) if (s.expires < now || !customer(s.cid)) { sessions.delete(k); n++; }
  if (n) persistSessions();
}, 3600e3).unref();

live.start();
app.listen(PORT, () => console.log(`[portal] ${BRAND.name} listening on :${PORT} (auth: ${AUTH_MODE})`));
