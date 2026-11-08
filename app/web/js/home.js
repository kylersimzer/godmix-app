// The homepage. Everything that makes sound here runs through one engine (engine.js, the app's own), one
// widget at a time, at 60% by default (the nav's volume control, remembered per browser). Nothing plays
// until it's clicked. Every illustration is drawn from the real album data, so nothing on the page is made up.
//
// The live pieces use the demo album (id "demo", 000 by Kyler Simzer): the hero player, the A/B slider, the
// transition (Find You → Mantra), the draggable running order, the analysis panel, the download and the
// sound changelog. Without the demo's data they stay hidden and the page still reads.
//
// Online (server.js --demo, <html class="demo">) the page is the same, but the app it opens is the demo album only,
// the download is made ahead of time, and nothing can be made or changed on the server.
import { createEngine } from './engine.js';
import { drawWave, drawArc } from './draw.js';
import { transitionChips } from './analysis.js';
import { esc, fmt, clamp, store } from './util.js';

const $ = (s, el = document) => el.querySelector(s), $$ = (s, el = document) => [...el.querySelectorAll(s)];
const nav = $('#nav');
const onScroll = () => nav.classList.toggle('scrolled', scrollY > 8);
addEventListener('scroll', onScroll, { passive: true }); onScroll();
const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { rootMargin: '0px 0px -8% 0px' });
$$('.rv').forEach(el => io.observe(el));
requestAnimationFrame(() => setTimeout(() => $('#shot').classList.add('in'), 120));
addEventListener('keydown', e => { if (e.key === 'Enter' && !e.target.closest('a,button,input')) location.href = '/app'; });
const ICON_PLAY = `<svg viewBox="0 0 16 16"><path d="M4.5 2.8v10.4c0 .6.6.9 1.1.6l8.2-5.2a.7.7 0 000-1.2L5.6 2.2c-.5-.3-1.1 0-1.1.6z" fill="currentColor"/></svg>`;
const ICON_PAUSE = `<svg viewBox="0 0 16 16"><rect x="3.5" y="2.5" width="3.2" height="11" rx="1" fill="currentColor"/><rect x="9.3" y="2.5" width="3.2" height="11" rx="1" fill="currentColor"/></svg>`;
const DEMO = 'demo', SLOWED = 'Slowed + Reverb', ONLINE = document.documentElement.classList.contains('demo');

// ───────────────────────────────────────────── the one engine, one owner at a time
const live = { E: null, data: null, byName: {}, owner: null, volume: clamp(+store.get('home.volume', 0.6) || 0.6, 0, 1) };
const byTitle = title => live.data?.tracks.find(t => t.title === title);
const versionOf = (t, label) => (t?.versions || []).find(v => v.label === label);
function claim(w) { if (live.owner && live.owner !== w) { const o = live.owner; live.E.pause(); live.E.loop = null; live.E.stopAt = null; live.E.blend = null; o.onRelease?.(); } live.owner = w; }
function release(w) { if (live.owner !== w) return; live.E.pause(); live.E.loop = null; live.E.stopAt = null; live.owner = null; w.onRelease?.(); }
function initEngine() {
  live.E = createEngine({ urlFor: (kind, n, v) => `/audio/${DEMO}/${kind}/${encodeURIComponent(n)}` + (v ? `?v=${encodeURIComponent(v)}` : ''), track: n => live.byName[n],
    onEnded: () => live.owner?.onEnded?.(), onChange: k => live.owner?.onChange?.(k) });
  live.E.setVolume(live.volume);
  window.godmix = live;                      // for poking at it from the console
  (function frame() { if (live.owner) live.owner.onTick?.(); requestAnimationFrame(frame); })();
  // the nav's volume: 60% unless you've moved it
  const vol = $('#navVol'), pct = $('#navVolPct');
  vol.value = live.volume; pct.textContent = Math.round(live.volume * 100) + '%';
  vol.oninput = () => { live.volume = +vol.value; live.E.setVolume(live.volume); store.set('home.volume', live.volume); pct.textContent = Math.round(live.volume * 100) + '%'; };
  $('#navVolWrap').hidden = false;
}
// a missing version can be made from here: the page is local, like the app
async function makeVersion(t, label, noteEl) {
  if (ONLINE) { noteEl.textContent = `Making ${label} comes with GODMIX on your own computer: free and open source.`; return; }
  try {
    const r = await fetch('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-God-Mix': '1' }, body: JSON.stringify({ kind: 'make', album: DEMO, tracks: [t.name], versions: [label] }) });
    noteEl.textContent = r.ok ? `Making ${label} for ${t.title}… reload this page in a minute.` : 'Couldn’t start that. Is the server running?';
  } catch { noteEl.textContent = 'Couldn’t reach the server.'; }
}

// ───────────────────────────────────────────── 1 · the hero: a working player over the screenshot
function hero() {
  const el = $('#live'), songs = ['Blue', 'Summer Rays', 'God Save Me When I Need You'].map(byTitle).filter(Boolean);
  if (!songs.length) return;
  let cur = songs[0], wantVer = false;
  el.innerHTML = `<div class="live-songs">${songs.map(t => `<button data-song="${esc(t.name)}">${esc(t.title)}</button>`).join('')}</div>
    <button class="live-play" aria-label="Play"></button>
    <div class="live-wave"><canvas></canvas><span class="live-hover" hidden></span></div>
    <span class="live-time mono">0:00</span>
    <div class="seg live-ab"><button data-ab="A">Album</button><button data-ab="B">${SLOWED}</button></div>
    <span class="live-meta mono"></span>`;
  el.hidden = false;
  const cv = $('canvas', el), play = $('.live-play', el), time = $('.live-time', el), meta = $('.live-meta', el);
  const E = live.E;
  const me = {
    onTick() { paint(); },
    onChange(k) { if (['play', 'pause', 'load', 'side'].includes(k)) paint(true); },
    onEnded() { paint(true); },
    onRelease() { paint(true); },
  };
  const ver = () => (wantVer ? versionOf(cur, SLOWED) : null);
  const mine = () => live.owner === me && E.cur === cur.name;
  function paint(full) {
    const on = mine() && !E.paused();
    if (full) {
      play.innerHTML = on ? ICON_PAUSE : ICON_PLAY;
      $$('[data-song]', el).forEach(b => b.classList.toggle('on', b.dataset.song === cur.name));
      const has = !!versionOf(cur, SLOWED);
      $$('[data-ab]', el).forEach(b => { b.classList.toggle('on', (b.dataset.ab === 'B') === (wantVer && has)); b.disabled = b.dataset.ab === 'B' && !has; b.title = b.dataset.ab === 'B' && !has ? `Make ${SLOWED} in the app to hear it` : ''; });
      const v = ver();
      meta.textContent = v ? `${Math.round(cur.bpm * v.speed)} bpm · ${v.I.toFixed(1)} LUFS` : `${Math.round(cur.bpm)} bpm · ${cur.after.I.toFixed(1)} LUFS`;
    }
    drawWave(cv, ver() || cur, { pos: mine() ? E.bTime() / E.dur() : -1 });
    time.textContent = mine() ? fmt(E.bTime()) : '0:00';
  }
  function start(at = null) {
    claim(me);
    const v = ver(), same = E.cur === cur.name && !!E.ver === !!v, song = same ? E.songTime() : 0;
    E.load(cur.name, { at: at ?? (v ? song / v.speed : song), play: true, version: v });
    E.setSide('B');
    paint(true);
  }
  play.onclick = () => { if (mine() && !E.paused()) { E.pause(); paint(true); } else start(mine() ? E.bTime() : 0); };
  el.addEventListener('click', e => {
    const s = e.target.closest('[data-song]'); if (s) { const was = mine() && !E.paused(); cur = live.byName[s.dataset.song]; if (was) start(0); else paint(true); return; }
    const ab = e.target.closest('[data-ab]'); if (ab && !ab.disabled) { wantVer = ab.dataset.ab === 'B'; if (live.owner === me && E.cur === cur.name) start(); else paint(true); }
  });
  const wave = $('.live-wave', el), hov = $('.live-hover', el);
  wave.addEventListener('pointermove', e => { const r = wave.getBoundingClientRect(), f = clamp((e.clientX - r.left) / r.width, 0, 1); hov.hidden = false; hov.style.left = f * 100 + '%'; hov.textContent = fmt(f * (ver()?.dur || cur.dur)); });
  wave.addEventListener('pointerleave', () => (hov.hidden = true));
  wave.addEventListener('click', e => { const r = wave.getBoundingClientRect(), f = clamp((e.clientX - r.left) / r.width, 0, 1); if (mine()) { E.seek(f * E.dur()); if (E.paused()) E.play(); } else start(f * (ver()?.dur || cur.dur)); });
  paint(true);
  addEventListener('resize', () => paint());
}

// ───────────────────────────────────────────── 4 · A/B: the album against its slowed version, loudness matched
function abSwitch() {
  const el = $('#abDemo'), t = byTitle('Blue') || live.data.tracks[0], v = versionOf(t, SLOWED);
  if (!t) return;
  const semis = v ? 12 * Math.log2(v.speed) : 0;
  el.innerHTML = `<div class="ab-top"><span class="label">A/B · ${esc(t.title)}</span><label class="ab-match"><input type="checkbox" checked> Match loudness</label></div>
    <div class="ab-switch">
      <button data-side="A"><kbd>A</kbd><b>Album version</b><small>${Math.round(t.bpm)} bpm · ${t.after.I.toFixed(1)} LUFS</small></button>
      <button data-side="B" ${v ? '' : 'disabled'}><kbd>B</kbd><b>${SLOWED}</b><small>${v ? `${Math.round(t.bpm * v.speed)} bpm · ${semis.toFixed(1)} st · ${v.I.toFixed(1)} LUFS` : 'not made yet'}</small></button>
    </div>
    <div class="ab-waves"><div class="ab-wave" data-w="A"><canvas></canvas></div><div class="ab-wave" data-w="B"><canvas></canvas></div></div>
    <div class="ab-foot"><button class="live-play" aria-label="Play"></button><div class="ab-meter"><i><b></b></i><i><b></b></i></div><span class="mono" id="abRead"></span></div>
    ${v ? '' : `<p class="ab-note">This song has no ${SLOWED} yet. <button class="linkbtn" data-make>Make it in GODMIX</button> and it appears here.</p>`}`;
  el.hidden = false;
  const E = live.E, play = $('.live-play', el), match = $('.ab-match input', el), read = $('#abRead', el), bars = $$('.ab-meter b', el);
  const cvA = $('[data-w="A"] canvas', el), cvB = $('[data-w="B"] canvas', el);
  let side = 'A';
  const mine = () => live.owner === me;
  const me = { onTick() { meter(); waves(); }, onChange(k) { if (['play', 'pause', 'load', 'side'].includes(k)) paint(); }, onEnded() { paint(); }, onRelease() { paint(); meter(true); waves(); } };
  function paint() {
    const on = mine() && !E.paused();
    play.innerHTML = on ? ICON_PAUSE : ICON_PLAY;
    $$('[data-side]', el).forEach(b => b.classList.toggle('on', b.dataset.side === side));
    $$('.ab-wave', el).forEach(w => w.classList.toggle('on', w.dataset.w === side));
    const diff = v ? v.I - t.after.I : 0;
    read.textContent = side === 'A' ? `Hearing A · the album version` : `Hearing B · ${SLOWED}${match.checked ? ` · turned ${diff <= 0 ? 'up' : 'down'} ${Math.abs(diff).toFixed(1)} dB to match` : ''}`;
    if (!on) read.textContent += ' · press play, then A or B';
    waves();
  }
  function waves() {
    const song = mine() ? E.songTime() : -1;
    drawWave(cvA, t, { pos: song >= 0 ? song / t.dur : -1 });
    drawWave(cvB, v || null, { pos: song >= 0 && v ? song / v.speed / v.dur : -1 });
  }
  function meter(reset) {
    const [l, r] = reset ? [-60, -60] : E.meter();
    [l, r].forEach((db, i) => { bars[i].style.width = clamp((db + 48) / 48, 0, 1) * 100 + '%'; bars[i].className = db > -0.3 ? 'clip' : db > -3 ? 'hot' : ''; });
  }
  function start() {
    claim(me);
    E.setMatch(match.checked);
    if (E.cur !== t.name || !!E.ver !== !!v) E.load(t.name, { at: v ? 30 / v.speed : 30, play: true, version: v }); else E.play();
    E.setSide(v ? side : 'B');
    paint();
  }
  function setSide(s) { if (s === 'B' && !v) return; side = s; if (mine()) E.setSide(s); else start(); paint(); }
  play.onclick = () => { if (mine() && !E.paused()) { E.pause(); paint(); } else start(); };
  el.addEventListener('click', e => { const b = e.target.closest('[data-side]'); if (b && !b.disabled) setSide(b.dataset.side); });
  match.onchange = () => { if (mine()) E.setMatch(match.checked); paint(); };
  $('[data-make]', el)?.addEventListener('click', () => makeVersion(t, SLOWED, $('.ab-note', el)));
  // A, B and Tab switch sides while this is the thing playing
  document.addEventListener('keydown', e => {
    if (!mine() || e.target.closest?.('input,textarea,button')) return;
    if (e.key === 'a' || e.key === 'A') setSide('A'); else if (e.key === 'b' || e.key === 'B') setSide('B'); else if (e.key === 'Tab') { e.preventDefault(); setSide(side === 'A' ? 'B' : 'A'); }
  });
  paint(); meter(true);
  addEventListener('resize', waves);
}

// ───────────────────────────────────────────── 3 · hear a seam: Find You → Mantra
function transition() {
  const el = $('#transDemo'), a = byTitle('Find You'), b = byTitle('Mantra');
  if (!a || !b) return;
  const TAIL = 5, HEAD = 5, GAP = 2;
  el.innerHTML = `<div class="tr-head"><span class="label">Hear a transition</span><span class="mono dim">last ${TAIL} s · ${GAP} s gap · first ${HEAD} s</span></div>
    <div class="tr-songs"><div class="tr-song" data-which="a"><span class="mono dim">07</span><b>${esc(a.title)}</b><span class="mono dim">${Math.round(a.bpm)} bpm · ${esc(a.camelot)}</span></div>
      <div class="tr-seam">${transitionChips(a, b).map(([k, l]) => `<span class="chip ${k}">${esc(l)}</span>`).join('')}</div>
      <div class="tr-song" data-which="b"><span class="mono dim">08</span><b>${esc(b.title)}</b><span class="mono dim">${Math.round(b.bpm)} bpm · ${esc(b.camelot)}</span></div></div>
    <div class="tr-foot"><button class="btn solid" id="trPlay">${ICON_PLAY}Play the seam</button><span class="mono dim" id="trState"></span></div>`;
  el.hidden = false;
  const E = live.E, btn = $('#trPlay', el), state = $('#trState', el);
  let phase = null, gapTimer = null;
  const mark = which => { $$('.tr-song', el).forEach(s => s.classList.toggle('on', s.dataset.which === which)); $('.tr-seam', el).classList.toggle('on', which === 'gap'); };
  const me = {
    onTick() { if (phase === 'a') state.textContent = `${a.title} ends in ${Math.max(0, E.dur() - E.bTime()).toFixed(1)} s`; else if (phase === 'b') state.textContent = `${b.title} · ${fmt(E.bTime())}`; },
    onEnded() { if (phase !== 'a') return; phase = 'gap'; mark('gap'); state.textContent = `${GAP} s of silence…`;
      gapTimer = setTimeout(() => { phase = 'b'; mark('b'); E.load(b.name, { at: 0, play: true }); E.stopAt = HEAD; }, GAP * 1000); },
    onChange(k) { if (k === 'preview-end') { phase = null; mark(null); state.textContent = 'That was the seam. Play it again, or change the gap in the app.'; btn.innerHTML = `${ICON_PLAY}Play again`; } },
    onRelease() { clearTimeout(gapTimer); phase = null; mark(null); state.textContent = ''; btn.innerHTML = `${ICON_PLAY}Play the seam`; },
  };
  btn.onclick = () => {
    if (live.owner === me && phase) { release(me); return; }
    claim(me); phase = 'a'; mark('a'); btn.innerHTML = `${ICON_PAUSE}Stop`;
    E.preload(b.name, null);
    E.load(a.name, { at: Math.max(0, a.dur - TAIL), play: true });
  };
}

// ───────────────────────────────────────────── 5 · a running order you can drag
function order() {
  const el = $('#orderDemo'), names = ['Blue', 'Summer Rays', 'God Save Me When I Need You'].map(byTitle).filter(Boolean).map(t => t.name);
  if (names.length < 2) return;
  const GAP = 2;
  let ord = [...names], dragName = null;
  el.innerHTML = `<div class="od-head"><span class="label">Running order</span><span class="mono dim">drag a song</span></div><div class="od-rows"></div><canvas class="od-arc"></canvas><p class="od-note dim">Every seam is re-read as you drag: tempo, key and energy. The arc is the album’s loudness in your order.</p>`;
  el.hidden = false;
  const rows = $('.od-rows', el), cv = $('.od-arc', el);
  function starts() { const st = {}; let t = 0; ord.forEach(n => { st[n] = t; t += live.byName[n].dur + GAP; }); return { st, total: t - GAP }; }
  function render() {
    rows.innerHTML = ord.map((n, i) => { const t = live.byName[n]; return `<div class="od-row" draggable="true" data-name="${esc(n)}"><span class="mono dim">${String(i + 1).padStart(2, '0')}</span><b>${esc(t.title)}</b><span class="mono dim">${Math.round(t.bpm)} bpm</span><span class="mono dim">${esc(t.camelot)}</span><span class="mono dim">${fmt(t.dur)}</span></div>` +
      (i < ord.length - 1 ? `<div class="od-seam">${transitionChips(t, live.byName[ord[i + 1]]).slice(0, 3).map(([k, l]) => `<span class="chip ${k}">${esc(l)}</span>`).join('')}</div>` : ''); }).join('');
    const { st, total } = starts();
    drawArc(cv, { order: ord, byName: live.byName, starts: st, total, cur: null, sel: null, pos: null });
  }
  rows.addEventListener('dragstart', e => { const r = e.target.closest('.od-row'); if (!r) return; dragName = r.dataset.name; r.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragName); });
  rows.addEventListener('dragend', () => { dragName = null; $$('.od-row', rows).forEach(r => r.classList.remove('dragging', 'drop-before', 'drop-after')); });
  rows.addEventListener('dragover', e => { if (!dragName) return; e.preventDefault(); const r = e.target.closest('.od-row'); $$('.od-row', rows).forEach(x => x.classList.remove('drop-before', 'drop-after'));
    if (!r || r.dataset.name === dragName) return; const b = r.getBoundingClientRect(); r.classList.add(e.clientY < b.top + b.height / 2 ? 'drop-before' : 'drop-after'); });
  rows.addEventListener('drop', e => { e.preventDefault(); const r = e.target.closest('.od-row'); if (!dragName || !r || r.dataset.name === dragName) return;
    const b = r.getBoundingClientRect(), after = e.clientY >= b.top + b.height / 2, name = dragName; ord = ord.filter(n => n !== name); ord.splice(ord.indexOf(r.dataset.name) + (after ? 1 : 0), 0, name); render(); });
  rows.addEventListener('click', e => { const r = e.target.closest('.od-row'); if (!r) return; const i = ord.indexOf(r.dataset.name); if (i > 0) { ord.splice(i, 1); ord.splice(i - 1, 0, r.dataset.name); render(); } });   // a click moves it up, for touch screens
  render();
  addEventListener('resize', render);
}

// ───────────────────────────────────────────── 2 · album cards drawn from the albums themselves
function albumCards(albums, all = albums) {
  const box = $('#albums');
  // online, the app has the demo only: 000's card opens it (the demo is 000), the others are just shown
  const open = a => (!ONLINE ? a.id : a.demo ? a.id : all.some(x => x.demo && x.title === a.title) ? DEMO : null);
  box.innerHTML = albums.map(a => { const id = open(a), tag = id ? 'a' : 'div';
    return `<${tag} class="alb"${id ? ` href="/app#/${encodeURIComponent(id)}"` : ''}><canvas class="alb-art" data-id="${esc(a.id)}"></canvas><b>${esc(a.title)}</b><span>${a.artist ? 'by ' + esc(a.artist) : (a.demo ? 'demo album' : '')}</span><small>${a.tracks} tracks · ${a.demo ? 'demo' : a.released ? 'released' : 'mastering'}${ONLINE && id ? ' · try it' : ''}</small></${tag}>`; }).join('');
  box.style.gridTemplateColumns = `repeat(${albums.length <= 5 ? albums.length : Math.ceil(albums.length / 2)}, 1fr)`;
  const draw = () => albums.forEach(a => {
    const cv = $(`canvas[data-id="${CSS.escape(a.id)}"]`, box), art = a.art; if (!cv || !art?.curve?.length) return;
    const dpr = devicePixelRatio || 1, size = cv.clientWidth; cv.width = cv.height = Math.round(size * dpr);
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, size, size);
    const c = size / 2, r0 = size * 0.17, room = size * 0.3, n = art.curve.length, ink = getComputedStyle(document.documentElement).getPropertyValue('--ink').trim();
    const cuts = new Set(art.bounds.map(b => Math.round(b * n)).filter(k => k > 0));
    // one arc per song, its radius following the loudness; the songs alternate in weight
    let i = 0, k = 0;
    while (i < n) {
      let j = i + 1; while (j < n && !cuts.has(j)) j++;
      g.beginPath();
      for (let m = i; m < j; m++) { const a0 = -Math.PI / 2 + (m / n) * Math.PI * 2, r = r0 + room * clamp((art.curve[m] + 36) / 30, 0, 1); g.lineTo(c + Math.cos(a0) * r, c + Math.sin(a0) * r); }
      for (let m = j - 1; m >= i; m--) { const a0 = -Math.PI / 2 + (m / n) * Math.PI * 2; g.lineTo(c + Math.cos(a0) * r0, c + Math.sin(a0) * r0); }
      g.closePath(); g.fillStyle = `rgba(${ink},${k % 2 ? 0.5 : 0.78})`; g.fill();
      i = j; k++;
    }
    g.beginPath(); g.arc(c, c, r0 * 0.55, 0, Math.PI * 2); g.fillStyle = `rgba(${ink},0.9)`; g.fill();
    g.beginPath(); g.arc(c, c, r0 * 0.14, 0, Math.PI * 2); g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(); g.fill();
  });
  draw(); addEventListener('resize', draw);
}

// ───────────────────────────────────────────── 8 · the analysis panel: one song as an instrument panel
function analysis() {
  const el = $('#analysisDemo'), t = byTitle('God Save Me When I Need You') || live.data.tracks[0];
  if (!t) return;
  const cam = /(\d+)([AB])/.exec(t.camelot), num = cam ? +cam[1] : 1, minor = cam ? cam[2] === 'A' : true;
  const pt = (rad, a) => `${(50 + rad * Math.cos(a)).toFixed(2)} ${(50 + rad * Math.sin(a)).toFixed(2)}`;
  const wedge = (i, inner) => { const a0 = ((i - 1) / 12) * Math.PI * 2 - Math.PI / 2 - Math.PI / 12, a1 = a0 + Math.PI / 6, R = inner ? 33 : 48, r = inner ? 17 : 35;
    return `M${pt(R, a0)}A${R} ${R} 0 0 1 ${pt(R, a1)}L${pt(r, a1)}A${r} ${r} 0 0 0 ${pt(r, a0)}Z`; };
  const wheel = [false, true].map(inner => Array.from({ length: 12 }, (_, k) => { const i = k + 1, on = i === num && inner === minor;
    return `<path d="${wedge(i, inner)}" class="${on ? 'on' : ''}"><title>${i}${inner ? 'A' : 'B'}</title></path>`; }).join('')).join('');
  const dial = (v, lo, hi) => { const f = clamp((v - lo) / (hi - lo), 0, 1), a = (-135 + f * 270 - 90) * Math.PI / 180, a0 = (-135 - 90) * Math.PI / 180;
    return `<svg viewBox="0 0 100 100" class="an-dial"><path d="M${pt(42, a0)}A42 42 0 1 1 ${pt(42, (135 - 90) * Math.PI / 180)}" class="track"/><path d="M${pt(42, a0)}A42 42 0 ${f > 0.5 ? 1 : 0} 1 ${pt(42, a)}" class="lit"/><line x1="50" y1="50" x2="${(50 + 30 * Math.cos(a)).toFixed(2)}" y2="${(50 + 30 * Math.sin(a)).toFixed(2)}" class="hand"/><circle cx="50" cy="50" r="4" class="cap"/></svg>`; };
  const bar = (label, v, lo, hi, unit) => `<div class="an-bar"><span>${label}</span><i><b style="width:${clamp((v - lo) / (hi - lo), 0, 1) * 100}%"></b></i><span class="mono">${v.toFixed(1)} ${unit}</span></div>`;
  el.innerHTML = `<div class="an-head"><span class="label">Analysis · ${esc(t.title)}</span><span class="an-fix"><i></i>corrected by hand</span></div>
    <div class="an-grid">
      <div class="an-cell"><div class="label">Tempo</div>${dial(t.bpm, 60, 180)}<div class="an-big mono">${t.bpm.toFixed(1)}<small> bpm</small></div><div class="an-sub dim">${Math.round(t.bpm)} bpm can also read as ${Math.round(t.bpm * 2)} in double time. The app lets you pick.</div></div>
      <div class="an-cell"><div class="label">Key · Camelot</div><svg viewBox="0 0 100 100" class="an-wheel">${wheel}</svg><div class="an-big mono">${esc(t.camelot)}<small> ${esc(t.key)}${t.key_sure ? '' : ' ?'}</small></div><div class="an-sub dim">${t.key_sure ? 'A confident reading.' : 'A low-confidence reading: the relative major is one click away.'}</div></div>
      <div class="an-cell an-levels"><div class="label">Levels</div>${bar('Loudness', t.after.I, -24, -6, 'LUFS')}${bar('Loud section', t.after.loud, -24, -6, 'LUFS')}${bar('Range', t.after.LRA, 0, 20, 'LU')}${bar('True peak', t.after.TP, -12, 0, 'dBTP')}<div class="an-sub dim">Measured by GODMIX, shown to the tenth. Any of them can be corrected in the app.</div></div>
    </div>`;
  el.hidden = false;
}

// ───────────────────────────────────────────── 7 · a real export to download
function exportDemo() {
  const el = $('#exportDemo'), t = byTitle('Blue') || live.data.tracks[0], a = live.data;
  if (!t) return;
  const year = a.year || new Date().getFullYear();
  el.innerHTML = `<div class="ex-phone"><div class="ex-phone-top"><img src="/api/cover?album=demo" alt="" onerror="this.onerror=null;this.src='/assets/icon-512.png'"><div><b>${esc(t.title)}</b><span>${esc(a.artist || '')}</span><span class="dim">${esc(a.title)} · ${year}</span></div></div>
      <dl class="ex-tags-list"><dt>Title</dt><dd>${esc(t.title)}</dd><dt>Artist</dt><dd>${esc(a.artist || '')}</dd><dt>Album</dt><dd>${esc(a.title)}</dd><dt>Track</dt><dd>1 / 1</dd><dt>Year</dt><dd>${year}</dd>${t.isrc ? `<dt>ISRC</dt><dd>${esc(t.isrc)}</dd>` : ''}<dt>Copyright</dt><dd>© ${year} ${esc(a.artist || '')}. All rights reserved.</dd><dt>Encoder</dt><dd>GODMIX</dd></dl></div>
    <div class="ex-dl"><div class="label">Download ${esc(t.title)}, tagged</div>
      ${[['wav', 'WAV', 'as made, bit-exact'], ['flac', 'FLAC', 'lossless'], ['mp3', 'MP3', '320 kbps']].map(([k, l, h]) => `<button class="btn line ex-btn" data-fmt="${k}"><b>${l}</b><small>${h}</small><span class="mono dim" data-state></span></button>`).join('')}
      <p class="dim ex-dl-note">${ONLINE ? 'Exported by GODMIX from the demo album' : 'Made the first time it’s asked for'}, with every tag and the cover. The same export runs for any song or the whole album in the app.</p></div>`;
  el.hidden = false;
  el.addEventListener('click', async e => {
    const b = e.target.closest('[data-fmt]'); if (!b || b.disabled) return;
    const fmt = b.dataset.fmt, st = $('[data-state]', b);
    if (!(await confirmDownload(t, a, fmt))) return;
    b.disabled = true; st.textContent = 'checking…';
    try {
      for (let i = 0; i < 600; i++) {
        const r = await (await fetch(`/api/demo-export?fmt=${fmt}`, { headers: { 'X-God-Mix': '1' } })).json();
        if (r.error) { st.textContent = r.error === 'not prepared' ? 'not available right now' : r.error; break; }
        if (r.ready) { st.textContent = `${(r.size / 1e6).toFixed(1)} MB`; location.href = r.url; break; }
        if (r.job.status === 'error') { st.textContent = `couldn’t: ${r.job.error || 'see the server'}`; break; }
        st.textContent = `preparing… ${Math.round((r.job.p || 0) * 100)}%`;
        await new Promise(res => setTimeout(res, 700));
      }
    } catch { st.textContent = 'is the server running?'; }
    b.disabled = false;
  });
}

// Before the download: say what the file is, whose it is, and what it's for.
function confirmDownload(t, a, fmt) {
  return new Promise(resolve => {
    const year = a.year || new Date().getFullYear(), who = a.artist ? ` by ${esc(a.artist)}` : '';
    const layer = document.createElement('div');
    layer.className = 'scrim';
    layer.innerHTML = `<div class="dialog confirm" role="dialog" aria-label="Download">
      <div class="label">Download · ${fmt.toUpperCase()}</div>
      <h3>${esc(t.title)}${who}, as GODMIX exports it</h3>
      <p>This is the real recording, written out the way the app writes any song: title, artist, album, year${t.isrc ? ', ISRC' : ''} and cover inside the file properties. Open it in a music app and the tags are all there.</p>
      <p class="dim">It’s for listening on your own machine. © ${year}${a.artist ? ' ' + esc(a.artist) : ''}. All rights reserved: no sharing, sampling or re-release.</p>
      <div class="confirm-btns"><button class="btn line" data-no>Not now</button><button class="btn solid" data-yes>Download ${fmt.toUpperCase()}</button></div></div>`;
    document.body.append(layer);
    const done = ok => { layer.remove(); document.removeEventListener('keydown', onKey, true); resolve(ok); };
    const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); done(false); } else if (e.key === 'Enter') { e.preventDefault(); done(true); } e.stopPropagation(); };
    document.addEventListener('keydown', onKey, true);
    layer.addEventListener('click', e => { if (e.target === layer || e.target.closest('[data-no]')) done(false); else if (e.target.closest('[data-yes]')) done(true); });
    $('[data-yes]', layer).focus();
  });
}

// ───────────────────────────────────────────── 9 · what's new, with sound
function changelog() {
  const el = $('#soundlog');
  const blue = byTitle('Blue'), rays = byTitle('Summer Rays'), god = byTitle('God Save Me When I Need You');
  if (!blue || !rays || !god) return;
  const E = live.E;
  let active = null;
  const me = {
    onTick() { if (active) active.el.querySelector('[data-state]').textContent = fmt(E.bTime()); },
    onChange(k) { if (k === 'preview-end') release(me); },
    onEnded() { if (active?.id !== 'gapless') release(me); },
    onRelease() { if (!active) return; clearTimeout(active.timer); clearInterval(active.timer); active.el.querySelector('.live-play').innerHTML = ICON_PLAY; active.el.classList.remove('on'); active.el.querySelector('[data-state]').textContent = ''; active = null; },
  };
  const items = [
    { id: 'loop', title: 'Loops that stay put', text: `Eight bars of ${blue.title}, round and round until you stop it: drag across any waveform in the app to make one.`,
      start() { E.load(blue.name, { at: 60, play: true }); E.setLoop(60, 60 + (8 * 4 * 60) / blue.bpm); } },
    { id: 'version', title: 'Versions on demand', text: `${blue.title}, ${SLOWED}: designed from the song’s own measurements and rendered with one click.`,
      start() { const v = versionOf(blue, SLOWED); if (!v) { this.el.querySelector('[data-state]').textContent = 'make it in the app first'; setTimeout(() => release(me), 1500); return; }
        E.load(blue.name, { at: 40 / v.speed, play: true, version: v }); E.stopAt = 52 / v.speed; } },
    { id: 'gapless', title: 'Gapless play-through', text: `The end of ${rays.title} straight into ${god.title}, no gap: the next song is already buffered.`,
      start() { E.preload(god.name, null); E.load(rays.name, { at: Math.max(0, rays.dur - 4), play: true });
        this.timer = setInterval(() => { if (live.owner === me && E.cur === rays.name && E.remaining() < 0.03) { clearInterval(this.timer); E.load(god.name, { at: 0, play: true }); E.stopAt = 5; } }, 10); } },
  ];
  el.innerHTML = items.map(it => `<div class="sl-row" data-id="${it.id}"><button class="live-play" aria-label="Play">${ICON_PLAY}</button><div><b>${esc(it.title)}</b><p>${esc(it.text)}</p></div><span class="mono dim" data-state></span></div>`).join('');
  el.hidden = false;
  el.addEventListener('click', e => {
    const row = e.target.closest('.sl-row'); if (!row || !e.target.closest('.live-play')) return;
    const it = items.find(x => x.id === row.dataset.id);
    if (active === it) { release(me); return; }
    claim(me); me.onRelease(); active = it; it.el = row; row.classList.add('on'); row.querySelector('.live-play').innerHTML = ICON_PAUSE; it.start();
  });
}

// ───────────────────────────────────────────── 10 · install: copy the commands, watch the sidebar work
function install() {
  const copy = $('#copyInstall'), code = $('#installCmd');
  // the one-go commands for this visitor's system: Windows by default, macOS/Linux when that's what they're on
  if (code?.dataset.nix && !/Windows/i.test(navigator.userAgent)) { code.textContent = code.dataset.nix; const os = $('#installOs'); if (os) os.textContent = '(macOS / Linux)'; }
  if (copy) copy.onclick = async () => { try { await navigator.clipboard.writeText(code.innerText.trim()); copy.textContent = 'Copied'; setTimeout(() => (copy.textContent = 'Copy'), 1400); } catch { copy.textContent = 'Select and copy'; } };
  // a replay of what the app's sidebar shows while it makes the demo's versions: the real messages, on a timer
  const el = $('#jobsReplay'); if (!el) return;
  const steps = [['Making versions', 0.05, 'Designing Blue from its measurements'], ['Making versions', 0.2, 'Designing Summer Rays from its measurements'], ['Making versions', 0.3, 'Rendering Blue (Slowed + Reverb)'],
    ['Making versions', 0.5, 'Rendering Summer Rays (Slowed + Reverb)'], ['Making versions', 0.7, 'Rendering God Save Me When I Need You (Slowed + Reverb)'], ['Making versions', 0.92, 'Measuring the new files for the app'], ['Made 3 versions', 1, 'Done']];
  let k = 0;
  const tick = () => { const [l, p, m] = steps[k]; el.innerHTML = `<div class="job"><div class="job-hd"><b>${esc(l)}</b><span class="mono">${Math.round(p * 100)}%</span></div><div class="bar"><i style="width:${Math.round(p * 100)}%"></i></div><div class="job-msg">${esc(m)}</div></div>`; k = (k + 1) % steps.length; };
  tick(); setInterval(tick, 1600);
}

// ───────────────────────────────────────────── the static figures and start-up
function bars(el, wave) {
  const n = +el.dataset.bars, on = +el.dataset.on;
  el.innerHTML = Array.from({ length: n }, (_, i) => {
    const v = wave ? Math.max(...wave.slice(Math.floor((i / n) * wave.length), Math.floor(((i + 1) / n) * wave.length) + 1)) : 0.5 + 0.4 * Math.sin(i * 0.7) * Math.sin(i * 0.13);
    return `<i class="${i / n <= on ? 'on' : ''}" style="height:${Math.max(6, Math.pow(v, 1.6) * 100)}%"></i>`;
  }).join('');
}
function arc(el, tracks) {
  const n = +el.dataset.arc;
  const curve = tracks ? tracks.flatMap(t => [...t.curve, -60, -60]) : Array.from({ length: 300 }, (_, i) => -14 + 5 * Math.sin(i / 8) - (i % 40 < 3 ? 30 : 0));
  el.innerHTML = Array.from({ length: n }, (_, i) => `<i style="height:${Math.max(0, Math.min(100, ((curve[Math.floor((i / n) * curve.length)] + 36) / 30) * 100))}%"></i>`).join('');
}

async function main() {
  let albums = [];
  try { albums = await (await fetch(ONLINE ? '/api/albums?cards=1' : '/api/albums')).json(); } catch {}
  const shown = albums.filter(a => ['000', 'O', '111'].includes(a.id));
  if (albums.length) albumCards(shown.length ? shown : albums, albums);
  try { live.data = await (await fetch(`/data/${DEMO}.json`)).json(); } catch { live.data = null; }
  const withVersion = live.data?.tracks.find(t => t.versions?.length) || live.data?.tracks[0];
  $$('.wavebar').forEach(el => bars(el, withVersion ? (withVersion.versions?.[0]?.wave || withVersion.wave) : null));
  $$('.arcv').forEach(el => arc(el, live.data?.tracks));
  install();
  if (!live.data) return;
  live.data.tracks.forEach(t => (live.byName[t.name] = t));
  initEngine();
  hero(); abSwitch(); transition(); order(); analysis(); exportDemo(); changelog();
  $('#notes pre.md em').textContent = `## 2. ${(byTitle('Summer Rays') || live.data.tracks[1]).title} (needs work)`;
}
main();
