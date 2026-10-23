// Live TV: loads channels from an M3U playlist and the programme guide from XMLTV.
// The M3U `group-title` of each channel is what packages.yaml calls a channel group,
// so Splynx tariffs decide exactly which channels a customer can open.

const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');
const { XMLParser } = require('fast-xml-parser');

const M3U_SRC = process.env.LIVETV_M3U || '';           // URL or file path
const EPG_SRC = process.env.LIVETV_EPG || '';           // URL or file path (.xml or .xml.gz)
const REFRESH_MIN = Number(process.env.LIVETV_REFRESH_MINUTES || 30);

let channels = [];          // [{id, name, logo, group, number, url, tvgId, hosts:Set}]
let byId = new Map();
let guide = new Map();      // tvgId -> [{start, stop, title, desc, category}]
let lastLoad = null;

async function readSource(src) {
  if (!src) return null;
  let buf;
  if (/^https?:\/\//i.test(src)) {
    const r = await fetch(src, { signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error(`${src} -> HTTP ${r.status}`);
    buf = Buffer.from(await r.arrayBuffer());
  } else {
    buf = fs.readFileSync(src);
  }
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  return buf.toString('utf8');
}

function parseAttrs(s) {
  const out = {};
  const re = /([\w-]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(s))) out[m[1].toLowerCase()] = m[2];
  return out;
}

function parseM3U(text) {
  const lines = text.split(/\r?\n/);
  const list = [];
  let cur = null;
  let n = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const comma = line.lastIndexOf(',');
      const attrs = parseAttrs(line.slice(0, comma > 0 ? comma : undefined));
      cur = {
        name: (comma > 0 ? line.slice(comma + 1) : attrs['tvg-name'] || 'Channel').trim(),
        tvgId: attrs['tvg-id'] || attrs['tvg-name'] || '',
        logo: attrs['tvg-logo'] || '',
        group: attrs['group-title'] || 'Other',
        number: attrs['tvg-chno'] ? Number(attrs['tvg-chno']) : null,
      };
    } else if (line.startsWith('#EXTGRP:') && cur) {
      cur.group = line.slice(8).trim();
    } else if (!line.startsWith('#') && cur) {
      cur.url = line;
      cur.id = crypto.createHash('sha1').update(cur.name + '|' + line).digest('hex').slice(0, 12);
      try { cur.hosts = new Set([new URL(line).host]); } catch { cur.hosts = new Set(); }
      cur.number = cur.number ?? ++n;
      cur.kind = /\.m3u8(\?|$)/i.test(line) || /\/hls\//i.test(line) ? 'hls' : 'ts';
      list.push(cur);
      cur = null;
    }
  }
  return list.sort((a, b) => (a.number || 0) - (b.number || 0));
}

// XMLTV time: "20261020200000 +0300"
function xmltvTime(s) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?/.exec(String(s || ''));
  if (!m) return null;
  const tz = m[7] || '+0000';
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}${tz.slice(0, 3)}:${tz.slice(3)}`;
  return Date.parse(iso);
}

function txt(v) {
  if (v == null) return '';
  if (Array.isArray(v)) v = v[0];
  if (typeof v === 'object') return String(v['#text'] ?? '');
  return String(v);
}

function parseEPG(xml) {
  const p = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', isArray: (n) => n === 'programme' });
  const doc = p.parse(xml);
  const progs = doc?.tv?.programme || [];
  const from = Date.now() - 3 * 3600e3;
  const to = Date.now() + 36 * 3600e3;
  const map = new Map();
  for (const pr of progs) {
    const start = xmltvTime(pr.start), stop = xmltvTime(pr.stop);
    if (!start || !stop || stop < from || start > to) continue;
    const ch = String(pr.channel || '');
    if (!map.has(ch)) map.set(ch, []);
    map.get(ch).push({ start, stop, title: txt(pr.title), desc: txt(pr.desc).slice(0, 400), category: txt(pr.category) });
  }
  for (const arr of map.values()) arr.sort((a, b) => a.start - b.start);
  return map;
}

async function load() {
  try {
    const m3u = await readSource(M3U_SRC);
    if (m3u) {
      const list = parseM3U(m3u);
      // keep hosts learnt from CDN redirects across reloads
      for (const c of list) {
        const old = byId.get(c.id);
        if (old) for (const h of old.hosts) c.hosts.add(h);
      }
      channels = list;
      byId = new Map(list.map((c) => [c.id, c]));
    }
  } catch (e) { console.error('[livetv] playlist load failed:', e.message); }
  try {
    const xml = await readSource(EPG_SRC);
    if (xml) guide = parseEPG(xml);
  } catch (e) { console.error('[livetv] EPG load failed:', e.message); }
  lastLoad = new Date();
  console.log(`[livetv] ${channels.length} channels, guide for ${guide.size} channels`);
}

function start() {
  if (!M3U_SRC) { console.log('[livetv] LIVETV_M3U not set — live TV disabled'); return; }
  load();
  setInterval(load, REFRESH_MIN * 60e3).unref();
}

function nowNext(c) {
  const list = guide.get(c.tvgId) || guide.get(c.name) || [];
  const t = Date.now();
  const i = list.findIndex((p) => p.start <= t && p.stop > t);
  if (i === -1) return { now: null, next: list.find((p) => p.start > t) || null };
  return { now: list[i], next: list[i + 1] || null };
}

function programmes(c, fromMs, toMs) {
  const list = guide.get(c.tvgId) || guide.get(c.name) || [];
  return list.filter((p) => p.stop > fromMs && p.start < toMs);
}

module.exports = {
  start, load, nowNext, programmes,
  all: () => channels,
  get: (id) => byId.get(id),
  status: () => ({ channels: channels.length, guideChannels: guide.size, lastLoad }),
  _parseM3U: parseM3U, _parseEPG: parseEPG,
};
