/* Flex customer app — vanilla JS, no build step. */
(() => {
  'use strict';
  const $ = (sel, el = document) => el.querySelector(sel);
  const app = $('#app');
  let brand = { name: 'Flex' };
  let me = null;
  let liveCache = null;

  // ───────── helpers ─────────
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
  const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const fmtDur = (s) => { s = Math.max(0, Math.floor(s)); const hh = Math.floor(s / 3600), mm = Math.floor(s / 60) % 60, ss = s % 60; return (hh ? hh + ':' + String(mm).padStart(2, '0') : mm) + ':' + String(ss).padStart(2, '0'); };
  const mins = (m) => !m ? '' : m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
  const imgUrl = (id, type = 'Primary', w = 400) => `/api/img/${id}?type=${type}&w=${w}`;

  const ICON = {
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/></svg>',
    back10: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 12a8 8 0 1 0 3-6.2"/><path d="M4 3v4h4"/><text x="12" y="15.5" font-size="7" text-anchor="middle" fill="currentColor" stroke="none" font-family="sans-serif">10</text></svg>',
    fwd10: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 12a8 8 0 1 1-3-6.2"/><path d="M20 3v4h-4"/><text x="12" y="15.5" font-size="7" text-anchor="middle" fill="currentColor" stroke="none" font-family="sans-serif">10</text></svg>',
    full: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
    vol: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M16 8.5a5 5 0 0 1 0 7"/></svg>',
    mute: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M16 9l5 6M21 9l-5 6"/></svg>',
    search: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>',
    heart: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/></svg>',
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 11l8-7 8 7v9h-5v-6H9v6H4z"/></svg>',
    tv: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M8 2l4 4 4-4"/></svg>',
    film: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/></svg>',
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4.5-6 8-6s7 2 8 6"/></svg>',
  };

  function toast(msg, ms = 3800) {
    document.querySelectorAll('.toast').forEach((t) => t.remove());
    const t = h(`<div class="toast" role="status">${esc(msg)}</div>`);
    document.body.append(t);
    setTimeout(() => t.remove(), ms);
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || (opts.body ? 'POST' : 'GET'),
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    if (res.status === 401 && !opts.allow401) { me = null; renderLogin(); throw Object.assign(new Error('login'), { quiet: true }); }
    if (res.status === 403 && data?.error === 'suspended') { renderSuspended(data.message); throw Object.assign(new Error('suspended'), { quiet: true }); }
    if (!res.ok) throw Object.assign(new Error(data?.error || 'Something went wrong. Please try again.'), { status: res.status, data });
    return data;
  }

  function applyBrand() {
    document.title = brand.name;
    const r = document.documentElement.style;
    if (brand.accent) {
      r.setProperty('--accent', brand.accent);
      const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(brand.accent);
      if (m) {
        const [rr, gg, bb] = m.slice(1).map((x) => parseInt(x, 16) / 255);
        const lum = 0.2126 * rr + 0.7152 * gg + 0.0722 * bb;
        r.setProperty('--accent-ink', lum > 0.5 ? '#1B1205' : '#FFFFFF');
      }
    }
  }
  const brandMark = () => brand.logo
    ? `<img src="${esc(brand.logo)}" alt="${esc(brand.name)}">`
    : `<span class="mark" aria-hidden="true"></span><span class="name">${esc(brand.name)}</span>`;

  // ───────── chrome ─────────
  function shell(active) {
    const links = [['#/', 'Home', 'home', ICON.home], ['#/live', 'Live TV', 'live', ICON.tv], ['#/browse', 'Movies & series', 'browse', ICON.film], ['#/plan', 'My plan', 'plan', ICON.user]];
    const nav = links.map(([href, label, key]) => `<a href="${href}" ${active === key ? 'aria-current="page"' : ''}>${label}</a>`).join('');
    const tabs = links.map(([href, label, key, ic]) => `<a href="${href}" ${active === key ? 'aria-current="page"' : ''}>${ic}${label}</a>`).join('');
    const initial = (me?.name || '?').trim()[0]?.toUpperCase() || '?';
    app.innerHTML = `
      <header class="bar" id="bar">
        <a class="brand" href="#/">${brandMark()}</a>
        <nav class="nav" aria-label="Main">${nav}</nav>
        <span class="spacer"></span>
        <form class="search" role="search" id="searchForm">${ICON.search}
          <label class="sr" for="q">Search</label>
          <input id="q" type="search" placeholder="Titles, channels" autocomplete="off" value="${esc(currentQuery())}">
        </form>
        <a class="avatar" href="#/plan" title="My plan">${esc(initial)}</a>
      </header>
      <main id="main"></main>
      <nav class="tabbar" aria-label="Main">${tabs}</nav>`;
    const q = $('#q');
    let tm;
    q.addEventListener('input', () => { clearTimeout(tm); tm = setTimeout(() => { if (q.value.trim().length >= 2) location.hash = '#/search?q=' + encodeURIComponent(q.value.trim()); }, 350); });
    $('#searchForm').addEventListener('submit', (e) => { e.preventDefault(); if (q.value.trim()) location.hash = '#/search?q=' + encodeURIComponent(q.value.trim()); });
    const bar = $('#bar');
    const onScroll = () => bar.classList.toggle('solid', scrollY > 40);
    window.onscroll = onScroll; onScroll();
    return $('#main');
  }
  function currentQuery() { const m = location.hash.match(/[?&]q=([^&]*)/); return m ? decodeURIComponent(m[1]) : ''; }

  // ───────── cards ─────────
  function card(item, wide = false) {
    const id = wide ? (item.thumb || item.backdrop || item.poster) : (item.poster || item.thumb);
    const type = wide ? (item.thumb ? 'Thumb' : item.backdrop ? 'Backdrop' : 'Primary') : 'Primary';
    const title = item.type === 'Episode' ? item.seriesName : item.name;
    const sub = item.type === 'Episode' ? `S${item.parentIndex ?? '?'}:E${item.index ?? '?'} ${item.name}` : [item.year, item.type === 'Series' ? 'Series' : mins(item.minutes)].filter(Boolean).join(', ');
    const el = h(`<button class="card ${wide ? 'wide' : ''}" type="button">
      <div class="art">${id ? `<img loading="lazy" alt="" src="${imgUrl(id, type, wide ? 560 : 340)}">` : ''}<div class="noart" ${id ? 'hidden' : ''}>${esc(title)}</div>
        ${item.progress && !item.played ? `<div class="bar-progress"><i style="width:${item.progress}%"></i></div>` : ''}</div>
      <div class="name">${esc(title)}</div><div class="meta">${esc(sub)}</div></button>`);
    const img = $('img', el);
    if (img) img.onerror = () => { img.remove(); $('.noart', el).hidden = false; };
    el.addEventListener('click', () => {
      if (wide && (item.progress || item.type === 'Episode')) playVod(item.id);
      else openTitle(item.type === 'Episode' ? item.seriesId : item.id);
    });
    return el;
  }

  function row(title, items, { wide = false, link = '' } = {}) {
    const el = h(`<section class="row"><h2>${esc(title)} ${link ? `<a href="${link}">See all</a>` : ''}</h2><div class="track"></div></section>`);
    const tr = $('.track', el);
    items.forEach((i) => tr.append(card(i, wide)));
    return el;
  }

  function chanTile(c) {
    const pct = c.now ? Math.min(100, Math.max(0, (Date.now() - c.now.start) / (c.now.stop - c.now.start) * 100)) : 0;
    const el = h(`<button class="chan ${c.locked ? 'locked' : ''}" type="button" aria-label="${esc(c.name)}${c.locked ? ' (not in your plan)' : ''}">
      <div class="logo">${c.logo ? `<img alt="" loading="lazy" src="${c.logo}">` : esc(c.name.slice(0, 3))}</div>
      <div class="title">${esc(c.now?.title || c.name)}</div>
      <div class="sub">${esc(c.name)}${c.now ? ' until ' + fmtTime(c.now.stop) : ''}</div>
      ${c.now ? `<div class="prog"><i style="width:${pct}%"></i></div>` : ''}</button>`);
    const img = $('img', el); if (img) img.onerror = () => { img.parentElement.textContent = c.name.slice(0, 3); };
    el.addEventListener('click', () => playLive(c));
    return el;
  }

  // ───────── home ─────────
  async function renderHome() {
    const main = shell('home');
    const [home, lv] = await Promise.all([api('/api/home'), api('/api/live/channels').catch(() => ({ channels: [] }))]);
    liveCache = lv;
    const hero = home.hero;
    if (hero) {
      const heroEl = h(`<section class="hero">
        <div class="hero-bg" style="background-image:url('${imgUrl(hero.backdrop, 'Backdrop', 1920)}')"></div>
        <div class="hero-copy">
          ${hero.logo ? `<img class="logo-img" alt="${esc(hero.name)}" src="${imgUrl(hero.logo, 'Logo', 840)}">` : `<h1>${esc(hero.name)}</h1>`}
          <div class="facts">${hero.score ? `<span class="score">★ ${hero.score}</span>` : ''}${hero.year ? `<span>${hero.year}</span>` : ''}${hero.rating ? `<span class="cert">${esc(hero.rating)}</span>` : ''}${hero.minutes ? `<span>${mins(hero.minutes)}</span>` : ''}${hero.genres.length ? `<span>${esc(hero.genres.join(', '))}</span>` : ''}</div>
          <p>${esc(hero.overview)}</p>
          <div class="actions">
            <button class="btn play" data-play>${ICON.play}${hero.progress ? 'Resume' : 'Play'}</button>
            <button class="btn ghost" data-info>${ICON.info}More info</button>
          </div>
        </div></section>`);
      $('[data-play]', heroEl).onclick = () => hero.type === 'Series' ? openTitle(hero.id) : playVod(hero.id);
      $('[data-info]', heroEl).onclick = () => openTitle(hero.id);
      main.append(heroEl);
    } else {
      main.append(h(`<div style="height:96px"></div>`));
    }

    const watchable = lv.channels.filter((c) => !c.locked);
    if (lv.channels.length) {
      const strip = h(`<section class="onnow" ${hero ? '' : 'style="margin-top:0"'}><div class="onnow-head"><h2><span class="dot"></span>On now</h2><a href="#/live">Full guide</a></div><div class="channels"></div></section>`);
      [...watchable, ...lv.channels.filter((c) => c.locked)].slice(0, 24).forEach((c) => $('.channels', strip).append(chanTile(c)));
      main.append(strip);
    }

    const rows = h('<div class="rows"></div>');
    home.rows.forEach((r) => rows.append(row(r.title, r.items, { wide: r.kind === 'landscape', link: r.libraryId ? '#/browse/' + r.libraryId : '' })));
    if (!home.rows.length && !lv.channels.length) {
      rows.append(h(`<div class="page empty"><strong>Nothing to watch yet</strong>Your provider is still adding titles to your plan. Check back soon.</div>`));
    }
    main.append(rows);
  }

  // ───────── browse ─────────
  async function renderBrowse(libId) {
    const main = shell('browse');
    const home = await api('/api/home');
    const libs = home.libraries;
    if (!libs.length) {
      main.append(h(`<div class="page"><div class="empty"><strong>No movie libraries in your plan</strong>${esc(me?.upsellMessage || 'Contact your provider to add movies and series.')}</div></div>`));
      return;
    }
    libId = libId || libs[0].id;
    const st = { genre: '', sort: 'DateCreated', start: 0 };
    const page = h(`<div class="page">
      <div class="page-head"><h1>Movies & series</h1>
        <div class="chips" role="group" aria-label="Library">${libs.map((l) => `<button class="chip" aria-pressed="${l.id === libId}" data-lib="${l.id}">${esc(l.name)}</button>`).join('')}</div>
        <span class="spacer" style="flex:1"></span>
        <label class="sr" for="sort">Sort</label>
        <select id="sort" class="sort"><option value="DateCreated">Recently added</option><option value="SortName">A to Z</option><option value="CommunityRating">Top rated</option><option value="PremiereDate">Release date</option></select>
      </div>
      <div class="chips" id="genres" style="margin-bottom:26px"></div>
      <div class="grid" id="grid"></div>
      <button class="btn ghost more" id="more" hidden>Show more</button></div>`);
    main.append(page);
    page.querySelectorAll('[data-lib]').forEach((b) => b.onclick = () => { location.hash = '#/browse/' + b.dataset.lib; });
    $('#sort', page).onchange = (e) => { st.sort = e.target.value; load(true); };
    async function load(reset) {
      if (reset) { st.start = 0; $('#grid').innerHTML = ''; }
      const r = await api(`/api/browse?parentId=${libId}&sort=${st.sort}&start=${st.start}${st.genre ? '&genre=' + encodeURIComponent(st.genre) : ''}`);
      r.items.forEach((i) => $('#grid').append(card(i)));
      if (r.genres?.length && !$('#genres').childElementCount) {
        const all = ['', ...r.genres];
        $('#genres').innerHTML = all.map((g) => `<button class="chip" aria-pressed="${g === st.genre}" data-g="${esc(g)}">${esc(g || 'All genres')}</button>`).join('');
        $('#genres').querySelectorAll('[data-g]').forEach((b) => b.onclick = () => {
          st.genre = b.dataset.g;
          $('#genres').querySelectorAll('.chip').forEach((x) => x.setAttribute('aria-pressed', x === b));
          load(true);
        });
      }
      st.start += r.items.length;
      $('#more').hidden = st.start >= r.total;
      if (!r.items.length && reset) $('#grid').append(h('<div class="empty"><strong>No titles here yet</strong>Try another genre or library.</div>'));
    }
    $('#more', page).onclick = () => load(false);
    load(true);
  }

  // ───────── search ─────────
  async function renderSearch(q) {
    const main = shell('');
    const page = h(`<div class="page"><div class="page-head"><h1>Results for “${esc(q)}”</h1></div><div id="res"></div></div>`);
    main.append(page);
    const input = $('#q'); input.focus(); input.setSelectionRange(q.length, q.length);
    const r = await api('/api/search?q=' + encodeURIComponent(q));
    const res = $('#res');
    if (r.channels.length) {
      const s = h('<section class="onnow" style="padding:0;margin:0 0 34px"><div class="onnow-head"><h2>Channels</h2></div><div class="channels"></div></section>');
      r.channels.forEach((c) => $('.channels', s).append(chanTile(c)));
      res.append(s);
    }
    if (r.items.length) {
      const g = h('<div class="grid"></div>');
      r.items.forEach((i) => g.append(card(i)));
      res.append(g);
    }
    if (!r.items.length && !r.channels.length) res.append(h(`<div class="empty"><strong>No matches</strong>Check the spelling, or try part of the title or channel name.</div>`));
  }

  // ───────── title details ─────────
  async function openTitle(id) {
    const it = await api('/api/item/' + id);
    const modal = h(`<div class="modal" role="dialog" aria-modal="true" aria-label="${esc(it.name)}">
      <div class="sheet">
        <button class="close" aria-label="Close">×</button>
        <div class="sheet-hero" style="background-image:url('${it.backdrop ? imgUrl(it.backdrop, 'Backdrop', 1280) : ''}')">
          <div>
            ${it.logo ? `<img class="logo-img" alt="${esc(it.name)}" src="${imgUrl(it.logo, 'Logo', 640)}">` : `<h2>${esc(it.name)}</h2>`}
            <div class="actions">
              <button class="btn play" data-play>${ICON.play}${it.type === 'Series' ? (it.nextUp ? `Play S${it.nextUp.parentIndex}:E${it.nextUp.index}` : 'Play') : it.progress ? 'Resume' : 'Play'}</button>
              <button class="icon-btn" data-fav aria-pressed="${it.favorite}" aria-label="My list">${ICON.heart}</button>
            </div>
          </div>
        </div>
        <div class="sheet-body">
          <div>
            <div class="facts">${it.score ? `<span class="score">★ ${it.score}</span>` : ''}${it.year ? `<span>${it.year}</span>` : ''}${it.rating ? `<span class="cert">${esc(it.rating)}</span>` : ''}${it.minutes && it.type !== 'Series' ? `<span>${mins(it.minutes)}</span>` : ''}${it.seasons ? `<span>${it.seasons.length} season${it.seasons.length === 1 ? '' : 's'}</span>` : ''}</div>
            <p>${esc(it.overview || '')}</p>
          </div>
          <div class="side">
            ${it.cast?.length ? `<div>Cast: <b>${esc(it.cast.join(', '))}</b></div>` : ''}
            ${it.allGenres?.length ? `<div>Genres: <b>${esc(it.allGenres.join(', '))}</b></div>` : ''}
            ${it.directors?.length ? `<div>Director: <b>${esc(it.directors.join(', '))}</b></div>` : ''}
          </div>
        </div>
        <div id="episodes"></div>
        ${it.similar?.length ? `<section><h3>More like this</h3><div class="similar" id="similar"></div></section>` : ''}
      </div></div>`);
    document.body.append(modal);
    document.body.style.overflow = 'hidden';
    const close = () => { modal.remove(); document.body.style.overflow = ''; document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    $('.close', modal).onclick = close;
    $('.close', modal).focus();
    $('[data-play]', modal).onclick = async () => {
      if (it.type !== 'Series') return playVod(it.id);
      if (it.nextUp) return playVod(it.nextUp.id);
      const first = it.seasons?.[0];
      if (first) { const eps = await api(`/api/series/${it.id}/episodes?season=${first.id}`); if (eps.items[0]) playVod(eps.items[0].id); }
    };
    const fav = $('[data-fav]', modal);
    fav.onclick = async () => {
      const on = fav.getAttribute('aria-pressed') !== 'true';
      await api(`/api/item/${it.id}/favorite`, { body: { on } });
      fav.setAttribute('aria-pressed', on);
      toast(on ? 'Added to my list' : 'Removed from my list');
    };
    (it.similar || []).forEach((s) => $('#similar', modal).append(card(s)));
    $('#similar', modal)?.addEventListener('click', close, true);

    if (it.seasons?.length) {
      const sec = h(`<section><h3>Episodes ${it.seasons.length > 1 ? `<label class="sr" for="season">Season</label><select id="season" class="sort">${it.seasons.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select>` : ''}</h3><div class="eps"></div></section>`);
      $('#episodes', modal).append(sec);
      const showSeason = async (sid) => {
        const eps = await api(`/api/series/${it.id}/episodes?season=${sid}`);
        const list = $('.eps', sec); list.innerHTML = '';
        eps.items.forEach((e) => {
          const el = h(`<button class="ep" type="button"><span class="num">${e.index ?? ''}</span>
            <div class="art">${e.poster ? `<img loading="lazy" alt="" src="${imgUrl(e.id, 'Primary', 320)}">` : ''}${e.progress && !e.played ? `<div class="bar-progress"><i style="width:${e.progress}%"></i></div>` : ''}</div>
            <div><b>${esc(e.name)}<span>${mins(e.minutes)}</span></b><p>${esc(e.overview || '')}</p></div></button>`);
          const img = $('img', el); if (img) img.onerror = () => img.remove();
          el.onclick = () => playVod(e.id);
          list.append(el);
        });
      };
      const pick = it.nextUp?.seasonId && it.seasons.find((s) => s.id === it.nextUp.seasonId) ? it.nextUp.seasonId : it.seasons[0].id;
      const sel = $('#season', sec);
      if (sel) { sel.value = pick; sel.onchange = () => showSeason(sel.value); }
      showSeason(pick);
    }
  }

  // ───────── live TV guide ─────────
  async function renderLive() {
    const main = shell('live');
    const g = await api('/api/live/guide?hours=6');
    const page = h(`<div class="page"><div class="page-head"><h1>Live TV</h1><div class="chips" id="groups" role="group" aria-label="Channel group"></div></div><div id="guide"></div></div>`);
    main.append(page);
    if (!g.channels.length) {
      $('#guide', page).append(h(`<div class="empty"><strong>No channels yet</strong>Live TV hasn't been set up for your plan. ${esc(me?.upsellMessage || '')}</div>`));
      return;
    }
    const groups = ['All', ...new Set(g.channels.map((c) => c.group))];
    let group = 'All';
    $('#groups', page).innerHTML = groups.map((x) => `<button class="chip" aria-pressed="${x === group}" data-g="${esc(x)}">${esc(x)}</button>`).join('');
    $('#groups', page).querySelectorAll('[data-g]').forEach((b) => b.onclick = () => {
      group = b.dataset.g;
      $('#groups', page).querySelectorAll('.chip').forEach((x) => x.setAttribute('aria-pressed', x === b));
      draw();
    });

    function draw() {
      const ppm = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--px-per-min')) || (innerWidth < 820 ? 4.5 : 6);
      const from = Math.floor(g.from / 1800e3) * 1800e3;
      const totalMin = (g.to - from) / 60e3;
      const width = totalMin * ppm;
      const ticks = []; for (let t = from; t < g.to; t += 1800e3) ticks.push(t);
      const list = g.channels.filter((c) => group === 'All' || c.group === group);
      const guide = h(`<div class="guide"><div class="guide-scroll"><div class="guide-inner">
        <div class="g-times"><div class="g-corner">Today</div>${ticks.map((t) => `<div class="g-tick">${fmtTime(t)}</div>`).join('')}</div>
      </div></div></div>`);
      const inner = $('.guide-inner', guide);
      const ppmCss = innerWidth < 820 ? 4.5 : 6;
      list.forEach((c) => {
        const r = h(`<div class="g-row ${c.locked ? 'locked' : ''}">
          <button class="g-chan" type="button" aria-label="Watch ${esc(c.name)}"><div class="logo">${c.logo ? `<img alt="" loading="lazy" src="${c.logo}">` : esc(c.name.slice(0, 3))}</div>
            <div><div class="n">${c.number ?? ''}</div><div class="t">${esc(c.name)}</div></div></button>
          <div class="g-progs" style="width:${totalMin * ppmCss}px"></div></div>`);
        const img = $('img', r); if (img) img.onerror = () => { img.parentElement.textContent = c.name.slice(0, 3); };
        $('.g-chan', r).onclick = () => playLive(c);
        const lane = $('.g-progs', r);
        if (!c.programmes.length) lane.append(h(`<div class="g-noguide">${esc(c.name)}, no guide available</div>`));
        c.programmes.forEach((p) => {
          const left = Math.max(0, (p.start - from) / 60e3) * ppmCss;
          const right = Math.min(totalMin, (p.stop - from) / 60e3) * ppmCss;
          const isNow = p.start <= Date.now() && p.stop > Date.now();
          const b = h(`<button class="g-prog ${isNow ? 'now' : ''}" type="button" style="left:${left + 3}px;width:${Math.max(0, right - left - 6)}px" title="${esc(p.title)} ${fmtTime(p.start)}–${fmtTime(p.stop)}${p.desc ? '\n\n' + esc(p.desc) : ''}"><b>${esc(p.title)}</b><span>${fmtTime(p.start)} to ${fmtTime(p.stop)}</span></button>`);
          b.onclick = () => isNow || p.start < Date.now() ? playLive(c) : toast(`${p.title} starts at ${fmtTime(p.start)} on ${c.name}`);
          lane.append(b);
        });
        inner.append(r);
      });
      const nowLeft = ((Date.now() - from) / 60e3) * ppmCss;
      const line = h(`<div class="g-nowline" style="left:calc(var(--ch-col) + ${nowLeft}px)"></div>`);
      inner.append(line);
      const box = $('#guide', page); box.innerHTML = ''; box.append(guide);
      $('.guide-scroll', guide).scrollLeft = Math.max(0, nowLeft - 120);
      void width;
    }
    draw();
  }

  // ───────── my plan ─────────
  async function renderPlan() {
    const main = shell('plan');
    me = await api('/api/me');
    const lv = liveCache || await api('/api/live/channels').catch(() => ({ groups: [], channels: [] }));
    const lockedGroups = [...new Set(lv.channels.filter((c) => c.locked).map((c) => c.group))];
    const page = h(`<div class="page plan">
      <div class="page-head"><h1>My plan</h1></div>
      <div class="plan-card">
        <h2>${esc(me.name)}</h2>
        <div class="muted">Signed in as ${esc(me.login)}</div>
        <dl class="kv">
          <dt>Your plan</dt><dd>${esc(me.plans.join(' + ') || 'None')}</dd>
          <dt>Screens at once</dt><dd>${me.maxStreams || 'Unlimited'}</dd>
          <dt>Watching now</dt><dd>${me.activeStreams}</dd>
        </dl>
      </div>
      ${me.pendingApproval?.length ? `<div class="plan-card"><h2>${esc(me.pendingApproval.join(', '))} is waiting for approval</h2>
        <p class="muted" style="margin:6px 0 0">You can watch your current channels and films now. The extra ones switch on as soon as it's approved.</p></div>` : ''}
      <div class="plan-card">
        <h2>Included channels</h2>
        <div class="taglist">${me.channelGroups.map((g) => `<span class="tag">${esc(g)}</span>`).join('') || '<span class="muted">No live channels in your plan</span>'}</div>
        ${me.libraries.length ? `<h2 style="margin-top:22px">Included libraries</h2><div class="taglist">${me.libraries.map((g) => `<span class="tag">${esc(g)}</span>`).join('')}</div>` : ''}
      </div>
      ${lockedGroups.length ? `<div class="plan-card">
        <h2>Add more</h2>
        <p class="muted" style="margin:6px 0 0">${esc(me.upsellMessage || 'Contact your provider to upgrade.')}</p>
        <div class="taglist">${lockedGroups.map((g) => `<span class="tag off">${esc(g)}</span>`).join('')}</div>
        ${brand.upgradeUrl ? `<a class="btn accent" style="margin-top:20px" href="${esc(brand.upgradeUrl)}" target="_blank" rel="noopener">Upgrade my plan</a>` : ''}
      </div>` : ''}
      <div id="getApp"></div>
      ${brand.support ? `<p class="muted">Need help? ${esc(brand.support)}</p>` : ''}
      <button class="btn ghost" id="logout">Sign out</button>
    </div>`);
    main.append(page);
    renderGetApp($('#getApp', page));
    $('#logout', page).onclick = async () => { await api('/api/logout', { body: {} }); me = null; location.hash = '#/'; renderLogin(); };
  }

  // ───────── get the app ─────────
  // Phones, laptops and TV boxes can install the web app; Android also gets a real app (APK).
  const inAndroidApp = /FlexApp/.test(navigator.userAgent);
  const standalone = () => inAndroidApp || matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  let installPrompt = null;
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; });
  async function renderGetApp(box) {
    if (!box || standalone()) return;
    const ua = navigator.userAgent;
    const isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    const isAndroid = /Android/.test(ua);
    const info = await api('/api/app').catch(() => ({}));
    const apk = info.android;
    const how = isIOS ? 'Tap the Share button in Safari, then <b>Add to Home Screen</b>.'
      : isAndroid ? (apk ? 'Download the app below. If your phone asks, allow installing apps from your browser.' : 'Open your browser menu, then tap <b>Install app</b> or <b>Add to Home screen</b>.')
      : 'In Chrome or Edge, click the install icon at the right of the address bar, or open the menu and choose <b>Install</b>.';
    const el = h(`<div class="plan-card">
      <h2>Get the app</h2>
      <p class="muted" style="margin:6px 0 16px">Watch ${esc(brand.name)} from your home screen, on your phone, laptop or TV box.</p>
      <div class="actions" style="display:flex;flex-wrap:wrap;gap:12px">
        <button class="btn accent" id="installBtn" hidden>Install ${esc(brand.name)}</button>
        ${apk ? `<a class="btn ${isAndroid ? 'accent' : 'ghost'}" href="${esc(apk.url)}" download>Download Android app (${Math.max(1, Math.round(apk.size / 1048576))} MB)</a>` : ''}
      </div>
      <p class="muted" style="margin:14px 0 0">${how}</p>
      ${apk ? '<p class="muted" style="margin:8px 0 0">The Android app works on phones and Android TV boxes. On a TV box, install it with a file manager or the Downloader app.</p>' : ''}
    </div>`);
    box.replaceWith(el);
    const btn = $('#installBtn', el);
    const show = () => { btn.hidden = !installPrompt; };
    show(); addEventListener('beforeinstallprompt', show);
    btn.onclick = async () => {
      if (!installPrompt) return;
      installPrompt.prompt();
      const r = await installPrompt.userChoice.catch(() => null);
      installPrompt = null; show();
      if (r?.outcome === 'accepted') toast(`${brand.name} is on your home screen`);
    };
  }
  function keepAwake(on) { try { window.FlexApp?.keepAwake?.(!!on); } catch { /* not in the Android app */ } }

  // ───────── TV remote and arrow keys ─────────
  // Arrow keys move focus to the nearest control in that direction, so the whole app
  // works with a TV remote. The player keeps its own keys (seek, channel up/down).
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([type=hidden]), select, [tabindex]:not([tabindex="-1"])';
  const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  function moveFocus(dir) {
    const scope = [...document.querySelectorAll('.modal')].pop() || app;
    const items = [...scope.querySelectorAll(FOCUSABLE)].filter(shown);
    const cur = document.activeElement;
    if (!cur || cur === document.body || !scope.contains(cur)) { const inMain = items.filter((el) => el.closest('main'));
      const first = inMain.find((el) => el.matches('.chan, .card, .g-chan, .btn, .chip, .field input')) || inMain[0] || items[0]; first?.focus(); return !!first; }
    const a = cur.getBoundingClientRect();
    const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
    let best = null, bestScore = Infinity;
    for (const el of items) {
      if (el === cur) continue;
      const b = el.getBoundingClientRect();
      const beyond = dir === 'left' ? b.right <= a.left + 1 : dir === 'right' ? b.left >= a.right - 1 : dir === 'up' ? b.bottom <= a.top + 1 : b.top >= a.bottom - 1;
      if (!beyond) continue;
      // left/right stay in the same row: at the end of a row nothing happens, like a TV menu
      if ((dir === 'left' || dir === 'right') && (b.bottom <= a.top + 2 || b.top >= a.bottom - 2)) continue;
      const dx = b.left + b.width / 2 - ax, dy = b.top + b.height / 2 - ay;
      const along = dir === 'left' ? -dx : dir === 'right' ? dx : dir === 'up' ? -dy : dy;
      const across = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx);
      const score = along + across * 2.5;
      if (score < bestScore) { bestScore = score; best = el; }
    }
    if (!best) return false;
    best.focus({ preventScroll: true });
    best.scrollIntoView({ block: dir === 'up' || dir === 'down' ? 'center' : 'nearest', inline: 'nearest', behavior: 'smooth' });
    return true;
  }
  document.addEventListener('keydown', (e) => {
    if (P || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target;
    const typing = t.tagName === 'INPUT' && !['button', 'submit', 'checkbox', 'radio', 'range'].includes(t.type);
    if ((e.key === 'GoBack' || e.key === 'BrowserBack' || (e.key === 'Backspace' && !typing))) { if (window.flexBack()) e.preventDefault(); return; }
    const dir = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }[e.key];
    if (!dir) return;
    if (typing && (dir === 'left' || dir === 'right')) return;     // move the text cursor
    if (moveFocus(dir)) e.preventDefault();
  });
  // Back button (Android app and TV remotes): close the player or details first, then go back a page.
  window.flexBack = () => {
    if (P) { closePlayer(); return true; }
    const m = [...document.querySelectorAll('.modal')].pop();
    if (m) { $('.close', m)?.click(); return true; }
    const hash = location.hash.replace(/^#/, '');
    if (hash && hash !== '/') { if (history.length > 1) history.back(); else location.hash = '#/'; return true; }
    return false;
  };

  // ───────── login & suspended ─────────
  function loginArt() {
    const tones = ['#F2B48A', '#E9C9A8', '#C9D6B8', '#F4D9C6', '#D8C3E0', '#F6CF8F', '#B9D3D0', '#EDB8A6'];
    let cells = '';
    for (let i = 0; i < 30; i++) cells += `<div style="background:linear-gradient(160deg, ${tones[i % 8]}, ${tones[(i * 3 + 1) % 8]})"></div>`;
    return cells;
  }
  function renderLogin(errMsg = '') {
    window.onscroll = null;
    app.innerHTML = `<div class="login">
      <div class="login-art" aria-hidden="true"><div class="wall">${loginArt()}</div>
        <div class="pitch"><h1>${esc(brand.name)}</h1><p>${esc(brand.tagline || '')}</p></div></div>
      <form class="login-form" id="loginForm" novalidate>
        <a class="brand" href="#/">${brandMark()}</a>
        <h2>Sign in to watch</h2>
        <p class="hint">${esc(brand.loginHint || '')}</p>
        <div class="err" id="err" ${errMsg ? '' : 'hidden'} role="alert">${esc(errMsg)}</div>
        <label class="field"><span>Customer login</span><input name="login" autocomplete="username" required autofocus></label>
        <label class="field"><span>Password</span><input name="password" type="password" autocomplete="current-password" required></label>
        <button class="btn accent" type="submit">Sign in</button>
        ${brand.support ? `<p class="support">Trouble signing in? ${esc(brand.support)}</p>` : ''}
      </form></div>`;
    const f = $('#loginForm');
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('button[type=submit]', f); btn.disabled = true; btn.textContent = 'Signing in…';
      try {
        await api('/api/login', { body: { login: f.login.value, password: f.password.value }, allow401: true });
        me = await api('/api/me');
        route();
      } catch (err) {
        if (err.quiet) return;
        const box = $('#err'); box.hidden = false; box.textContent = err.message;
        btn.disabled = false; btn.textContent = 'Sign in';
      }
    });
  }
  function renderSuspended(msg) {
    closePlayer(true);
    app.innerHTML = `<div class="login"><div class="login-art" aria-hidden="true"><div class="wall">${loginArt()}</div></div>
      <div class="login-form"><a class="brand" href="#/">${brandMark()}</a>
      <h2>TV access is paused</h2><p class="hint">${esc(msg || '')}</p>
      ${brand.upgradeUrl ? `<a class="btn accent" href="${esc(brand.upgradeUrl)}" target="_blank" rel="noopener">Go to the customer portal</a>` : ''}
      ${brand.support ? `<p class="support">${esc(brand.support)}</p>` : ''}
      <button class="btn ghost" style="margin-top:14px" id="retry">Try again</button></div></div>`;
    $('#retry').onclick = () => { location.reload(); };
  }

  // ───────── player ─────────
  let P = null; // current player state

  function buildPlayer({ title, subtitle, live }) {
    closePlayer(true);
    const el = h(`<div class="player" role="dialog" aria-label="Player">
      <video playsinline autoplay></video>
      <div class="p-ui">
        <div class="p-top"><button class="back" aria-label="Close player">←</button>
          <div class="p-title">${esc(title)}<small>${esc(subtitle || '')}</small></div>
          ${live ? '<span class="p-live"><span class="dot"></span>Live</span>' : ''}</div>
        <div class="p-bottom">
          ${live ? '' : '<input class="p-seek" type="range" min="0" max="1000" value="0" aria-label="Seek">'}
          <div class="p-ctrls">
            <button data-a="toggle" aria-label="Play or pause">${ICON.pause}</button>
            ${live ? '' : `<button data-a="back" aria-label="Back 10 seconds">${ICON.back10}</button><button data-a="fwd" aria-label="Forward 10 seconds">${ICON.fwd10}</button>`}
            <button data-a="mute" aria-label="Mute">${ICON.vol}</button>
            <span class="p-time"></span>
            <span class="grow"></span>
            <span class="p-extra"></span>
            <button data-a="full" aria-label="Full screen">${ICON.full}</button>
          </div>
        </div>
      </div>
      <div class="p-msg"><div class="spinner" style="background:none;padding:0"></div></div>
    </div>`);
    document.body.append(el);
    document.body.style.overflow = 'hidden';
    const video = $('video', el);
    const state = { el, video, live, timers: [], hls: null, ts: null };
    P = state;

    let idleT;
    const wake = () => { el.classList.remove('idle'); clearTimeout(idleT); idleT = setTimeout(() => !video.paused && el.classList.add('idle'), 3000); };
    el.addEventListener('mousemove', wake); el.addEventListener('touchstart', wake, { passive: true }); wake();
    const toggle = () => video.paused ? video.play() : video.pause();
    video.addEventListener('click', toggle);
    video.addEventListener('play', () => { $('[data-a=toggle]', el).innerHTML = ICON.pause; wake(); keepAwake(true); });
    video.addEventListener('pause', () => { $('[data-a=toggle]', el).innerHTML = ICON.play; el.classList.remove('idle'); keepAwake(false); });
    video.addEventListener('playing', () => setMsg(null));
    video.addEventListener('waiting', () => setMsg('<div class="spinner"></div>', true));
    $('.back', el).onclick = () => closePlayer();
    el.querySelectorAll('[data-a]').forEach((b) => b.onclick = () => {
      const a = b.dataset.a;
      if (a === 'toggle') toggle();
      if (a === 'back') video.currentTime = Math.max(0, video.currentTime - 10);
      if (a === 'fwd') video.currentTime += 10;
      if (a === 'mute') { video.muted = !video.muted; b.innerHTML = video.muted ? ICON.mute : ICON.vol; }
      if (a === 'full') document.fullscreenElement ? document.exitFullscreen() : el.requestFullscreen?.();
    });
    state.onKey = (e) => {
      if (e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
      if (e.key === 'Escape' && !document.fullscreenElement) closePlayer();
      if (e.key === ' ' || e.key === 'k') { e.preventDefault(); toggle(); }
      if ((e.key === 'Enter' || e.key === 'MediaPlayPause') && !e.target.closest?.('button, select')) { e.preventDefault(); toggle(); }
      if (!live && e.key === 'ArrowLeft') video.currentTime -= 10;
      if (!live && e.key === 'ArrowRight') video.currentTime += 10;
      if (e.key === 'f') document.fullscreenElement ? document.exitFullscreen() : el.requestFullscreen?.();
      if (e.key === 'm') { video.muted = !video.muted; }
      if (live && (e.key === 'ArrowUp' || e.key === 'PageUp')) zap(-1);
      if (live && (e.key === 'ArrowDown' || e.key === 'PageDown')) zap(1);
      wake();
    };
    document.addEventListener('keydown', state.onKey);
    return state;
  }

  function setMsg(html, spinnerOnly) {
    if (!P) return;
    const m = $('.p-msg', P.el);
    if (!html) { m.hidden = true; return; }
    m.hidden = false;
    m.innerHTML = spinnerOnly ? html : `<div>${html}</div>`;
  }

  function attachSource(state, url, kind) {
    const v = state.video;
    if (kind === 'ts') {
      if (window.mpegts?.isSupported()) {
        const pl = mpegts.createPlayer({ type: 'mpegts', isLive: true, url }, { enableStashBuffer: false, liveBufferLatencyChasing: true });
        pl.attachMediaElement(v); pl.load(); pl.play();
        pl.on(mpegts.Events.ERROR, () => setMsg('<b>Channel unavailable</b>This channel isn\'t broadcasting right now. Try another one.'));
        state.ts = pl;
      } else setMsg('<b>Not supported on this device</b>Open this channel in Chrome or our TV app.');
      return;
    }
    if (v.canPlayType('application/vnd.apple.mpegurl') && !window.Hls?.isSupported()) {
      v.src = url;
    } else if (window.Hls?.isSupported()) {
      const hls = new Hls({ maxBufferLength: 30, backBufferLength: 60, lowLatencyMode: !!state.live });
      hls.loadSource(url); hls.attachMedia(v);
      hls.on(Hls.Events.ERROR, (_, d) => {
        if (!d.fatal) return;
        if (d.response?.code === 401) return closePlayer(true), renderLogin();
        if (d.response?.code === 429) return setMsg('<b>Too many screens</b>Your plan\'s screen limit is reached. Stop watching on another device first.');
        if (d.response?.code === 403) return setMsg('<b>Not in your plan</b>' + esc(me?.upsellMessage || ''));
        if (d.type === Hls.ErrorTypes.NETWORK_ERROR && (state.retries = (state.retries || 0) + 1) < 4) return setTimeout(() => hls.startLoad(), 1500);
        if (d.type === Hls.ErrorTypes.MEDIA_ERROR) return hls.recoverMediaError();
        setMsg(state.live ? '<b>Channel unavailable</b>This channel isn\'t broadcasting right now. Try another one.' : '<b>Playback stopped</b>Check your connection and try again.');
      });
      state.hls = hls;
    } else {
      setMsg('<b>Not supported on this browser</b>Please update your browser.');
    }
    v.play().catch(() => { /* autoplay blocked: user presses play */ });
  }

  async function playVod(id) {
    let info;
    try { info = await api('/api/play/' + id, { body: {} }); } catch (e) { if (!e.quiet) toast(e.message); return; }
    document.querySelectorAll('.modal').forEach((m) => m.remove());
    const it = info.item;
    const title = it.type === 'Episode' ? it.seriesName : it.name;
    const sub = it.type === 'Episode' ? `S${it.parentIndex}:E${it.index}  ${it.name}` : [it.year, mins(it.minutes)].filter(Boolean).join(', ');
    const st = buildPlayer({ title, subtitle: sub, live: false });
    st.vod = { id, playSessionId: info.playSessionId, mediaSourceId: info.mediaSourceId };
    const v = st.video;
    const dur = () => info.durationSeconds || v.duration || 0;
    attachSource(st, info.url, 'hls');
    let started = false;
    v.addEventListener('loadedmetadata', () => {
      if (info.startSeconds && !started) v.currentTime = info.startSeconds;
      if (!started) { started = true; report('start'); }
    });
    // subtitles
    if (info.subtitles.length) {
      info.subtitles.forEach((s, i) => v.append(h(`<track kind="subtitles" label="${esc(s.label)}" srclang="${esc(s.lang)}" src="${s.url}"${i < 0 ? ' default' : ''}>`)));
      const sel = h(`<select aria-label="Subtitles"><option value="-1">Subtitles off</option>${info.subtitles.map((s, i) => `<option value="${i}">${esc(s.label)}</option>`).join('')}</select>`);
      sel.onchange = () => [...v.textTracks].forEach((t, i) => { t.mode = String(i) === sel.value ? 'showing' : 'disabled'; });
      $('.p-extra', st.el).append(sel);
    }
    const seek = $('.p-seek', st.el); const time = $('.p-time', st.el);
    let dragging = false;
    seek.addEventListener('input', () => { dragging = true; time.textContent = fmtDur(seek.value / 1000 * dur()) + ' / ' + fmtDur(dur()); });
    seek.addEventListener('change', () => { v.currentTime = seek.value / 1000 * dur(); dragging = false; });
    v.addEventListener('timeupdate', () => {
      if (dragging || !dur()) return;
      seek.value = Math.round(v.currentTime / dur() * 1000);
      time.textContent = fmtDur(v.currentTime) + ' / ' + fmtDur(dur());
    });
    const report = (event) => api('/api/progress', { body: { itemId: id, seconds: v.currentTime || 0, paused: v.paused, event, ...st.vod } }).catch(() => {});
    st.timers.push(setInterval(() => report('progress'), 10000));
    v.addEventListener('pause', () => report('progress'));
    v.addEventListener('ended', () => closePlayer());
    st.report = report;
  }

  let liveList = [];
  async function playLive(c) {
    if (c.locked) return toast(me?.upsellMessage || `${c.name} isn't in your plan.`, 5000);
    let info;
    try { info = await api(`/api/live/${c.id}/play`); } catch (e) { if (!e.quiet) toast(e.message, 5000); return; }
    if (!liveList.length || !liveList.some((x) => x.id === c.id)) {
      const lv = liveCache || await api('/api/live/channels');
      liveList = lv.channels.filter((x) => !x.locked);
    }
    const ch = info.channel;
    const st = buildPlayer({ title: ch.name, subtitle: ch.now ? `${ch.now.title}, until ${fmtTime(ch.now.stop)}` : (ch.number ? 'Channel ' + ch.number : ''), live: true });
    st.channel = ch;
    const zapEl = h(`<div class="zap"><button aria-label="Previous channel">▲</button><button aria-label="Next channel">▼</button></div>`);
    zapEl.children[0].onclick = () => zap(-1); zapEl.children[1].onclick = () => zap(1);
    $('.p-ui', st.el).append(zapEl);
    $('.p-time', st.el).textContent = ch.next ? `Next: ${ch.next.title} at ${fmtTime(ch.next.start)}` : '';
    attachSource(st, info.url, info.kind);
  }
  function zap(dir) {
    if (!P?.channel || liveList.length < 2) return;
    const i = liveList.findIndex((x) => x.id === P.channel.id);
    const next = liveList[(i + dir + liveList.length) % liveList.length];
    playLive(next);
  }

  function closePlayer(silent) {
    if (!P) return;
    const st = P; P = null;
    st.timers.forEach(clearInterval);
    if (st.report) st.report('stop');
    if (st.channel) api(`/api/live/${st.channel.id}/stop`, { body: {} }).catch(() => {});
    try { st.hls?.destroy(); } catch { /* */ }
    try { st.ts?.destroy(); } catch { /* */ }
    st.video.removeAttribute('src'); st.video.load();
    document.removeEventListener('keydown', st.onKey);
    keepAwake(false);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    st.el.remove();
    document.body.style.overflow = '';
    if (!silent && location.hash.startsWith('#/') && !location.hash.startsWith('#/live')) {
      // refresh continue-watching on home
      if (location.hash === '#/' || location.hash === '') route();
    }
  }
  window.addEventListener('pagehide', () => closePlayer(true));


  // ───────── moving light on the glass (mouse on computers, tilt on phones) ─────────
  (function lightSource() {
    const root = document.documentElement.style;
    let tx = 30, ty = 10, cx = 30, cy = 10, raf = 0;
    const step = () => {
      cx += (tx - cx) * 0.12; cy += (ty - cy) * 0.12;          // ease like real glass
      root.setProperty('--lx', cx.toFixed(1) + '%');
      root.setProperty('--ly', cy.toFixed(1) + '%');
      raf = Math.abs(tx - cx) + Math.abs(ty - cy) > 0.2 ? requestAnimationFrame(step) : 0;
    };
    const aim = (x, y) => { tx = Math.max(0, Math.min(100, x)); ty = Math.max(0, Math.min(100, y)); if (!raf) raf = requestAnimationFrame(step); };
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') aim(e.clientX / innerWidth * 100, e.clientY / innerHeight * 100); }, { passive: true });
    // scrolling drifts the light a little, so glass shimmers as content moves under it
    addEventListener('scroll', () => aim(tx, 10 + (scrollY % 600) / 600 * 30), { passive: true });
    const onTilt = (e) => {
      if (e.gamma == null) return;
      aim(50 + e.gamma * 1.6, 30 + (e.beta - 45) * 1.2);       // left/right tilt, forward/back tilt
    };
    const startTilt = () => {
      const D = window.DeviceOrientationEvent;
      if (D && typeof D.requestPermission === 'function') {       // iPhone asks once, on first tap
        D.requestPermission().then((r) => { if (r === 'granted') addEventListener('deviceorientation', onTilt); }).catch(() => {});
      } else if (D) addEventListener('deviceorientation', onTilt);
    };
    if (matchMedia('(pointer: coarse)').matches) addEventListener('touchend', startTilt, { once: true });
  })();

  // ───────── router ─────────
  async function route() {
    if (!me) {
      try { me = await api('/api/me', { allow401: true }); } catch (e) { if (e.quiet) return; return renderLogin(); }
    }
    closePlayer(true);
    document.querySelectorAll('.modal').forEach((m) => m.remove());
    document.body.style.overflow = '';
    const hash = location.hash.replace(/^#/, '') || '/';
    scrollTo(0, 0);
    try {
      if (hash === '/' || hash === '') await renderHome();
      else if (hash === '/live') await renderLive();
      else if (hash.startsWith('/browse')) await renderBrowse(hash.split('/')[2]);
      else if (hash.startsWith('/search')) await renderSearch(currentQuery());
      else if (hash === '/plan') await renderPlan();
      else if (hash.startsWith('/title/')) { await renderHome(); openTitle(hash.split('/')[2]); }
      else { location.hash = '#/'; }
    } catch (e) {
      if (e.quiet) return;
      console.error(e);
      const main = $('#main') || app;
      main.innerHTML = `<div class="page"><div class="empty"><strong>Couldn't load this page</strong>${esc(e.message)} <button class="btn ghost" style="margin-top:16px" onclick="location.reload()">Reload</button></div></div>`;
    }
  }
  window.addEventListener('hashchange', route);
  if ('serviceWorker' in navigator && !inAndroidApp) navigator.serviceWorker.register('/sw.js').catch(() => {});

  (async () => {
    try { brand = await (await fetch('/api/brand')).json(); } catch { /* defaults */ }
    applyBrand();
    try {
      const r = await fetch('/api/me', { credentials: 'same-origin' });
      if (r.status === 401) return renderLogin();
      if (r.status === 403) { const d = await r.json(); return renderSuspended(d.message); }
      me = await r.json();
    } catch { return renderLogin('Can\'t reach the server. Check your connection.'); }
    route();
  })();
})();
