// GODMIX app, by Kyler Simzer (kyler@stems.fm): albums → running order → player. One page; state is saved per album on the local server.
//
// Per-album state (state/<album>.json, readable by Claude):
//   order        running order (track ids = source filenames)
//   notes        free-text note per track          marks   timestamped notes per track: [{t, text}] (t = song time)
//   status       '' | 'work' | 'done' per track     albumNotes, settings {cont, gap, tlen, match, mode}, last {track, t}
//   titles       renamed titles (shown everywhere, used in exports)    meta, isrc, exportPrefs  the export dialog's tags
//   fixes        corrected analysis per track {bpm, key, I, loud, LRA, TP, bright_hz, start_lufs, end_lufs}
//   pad          the Notes notepad {tabs: [{id, title, text}], active}      albumNotes = the "Mix notes" box
// Per-browser preferences (localStorage): theme, volume, panel and transitions visibility, last album.
//
// The online demo (server.js --demo marks the page <html class="demo">) has the demo album only and keeps the state
// above in this browser (localStorage, godmix.demo.<album>). What needs your own machine (making versions, exports,
// adding or editing albums) says so instead of running, and there are no folders to open.
//
// The app's moving parts are explicit state machines, each documented where it lives (and in docs/APP.md):
//   G.phase    the album lifecycle: starting → empty | loading → ready (below, under "loading")
//   seq        what happens when a song ends: play-through gaps and Hear transition (sequence.mjs)
//   watch      jobs: queued → running → done | error, or gone if the server restarts (jobwatch.mjs)
//   E          the audio engine: A/B sides, one or two clocks, loops (engine.js)
//   editing    the analysis panel: viewing, or correcting one track's values
// In the browser console, godmix.state() shows them all at once.
import { $, $$, esc, fmt, fmtLong, pad2, enc, clamp, debounce, toast, tooltips, store, ICON, STATUS, STATUS_ORDER, MOD } from './util.js';
import { createEngine } from './engine.js';
import { createSequencer } from './sequence.mjs';
import { createJobWatch, isLive, FINISHED } from './jobwatch.mjs';
import { drawWave, drawArc } from './draw.js';
import { initCommands } from './command.js';
import { transitionChips, edgeSummary } from './analysis.js';
import { openExport, downloadTracklist } from './export.js';
import { createNotepad } from './notepad.js';
import { openAlbumDialog } from './albumdialog.js';
import { openTraceTags } from './tracetags.js';

const DEMO = document.documentElement.classList.contains('demo');
const G = { phase: 'starting', ticket: 0, albums: [], aid: null, data: null, byName: {}, defaultOrder: [], S: null, sel: null, undo: [], redo: [], version: '' };
const FRESH = () => ({ order: [], notes: {}, marks: {}, status: {}, titles: {}, fixes: {}, meta: null, isrc: {}, pad: null, albumNotes: '', settings: { cont: false, gap: 2, tlen: 10, match: false, mode: 'stereo' }, last: null });
const PREFS = { theme: store.get('theme', null), volume: store.get('volume', 0.9), insp: store.get('insp', true), trans: store.get('trans', true) };

const api = {
  json: async url => { const r = await fetch(url); if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json(); },
  post: (url, body, keepalive = false) => fetch(url, { method: 'POST', keepalive, headers: { 'Content-Type': 'application/json', 'X-God-Mix': '1' }, body: JSON.stringify(body) }),
};
const track = n => G.byName[n];
const pretty = n => G.S?.titles?.[n] || track(n)?.title || String(n).replace(/^\d+\.\s*/, '').replace(/\.wav$/i, '');
const audioUrl = (kind, n, v) => `/audio/${enc(G.aid)}/${kind}/${enc(n)}` + (v ? `?v=${enc(v)}` : '');
const gap = () => +G.S.settings.gap;
const E = createEngine({ urlFor: audioUrl, track, onEnded, onChange });
// what happens when a song ends (sequence.mjs): the app supplies the effects
const seq = createSequencer({
  gap, cont: () => !!G.S?.settings.cont, next: () => nextName(), title: n => pretty(n), play: n => play(n),
  stopAt: s => { E.stopAt = s; },
  note: text => { const el = $('#gapNote'); el.hidden = !text; if (text) el.textContent = text; },
  changed: () => { if (G.phase === 'ready') { renderPlayer(); preloadNext(); } },
});

// ───────────────────────────────────────────── saving
// Only in the ready phase, when G.S is certainly G.aid's state (see the album lifecycle below).
const saveNow = (keepalive = false) => G.phase === 'ready' && G.S && (DEMO ? store.set(`demo.${G.aid}`, G.S)
  : api.post(`/api/state?album=${enc(G.aid)}`, G.S, keepalive).catch(() => toast('Couldn’t save. Is the GODMIX server still running?')));
// online, the things that need GODMIX on your own machine explain that instead of running
const needsInstall = what => toast(`${what} comes with GODMIX on your own computer: free and open source.`,
  { action: 'Get GODMIX', onAction: () => window.open('https://github.com/kylersimzer/godmix-app', '_blank', 'noopener'), ms: 7000 });
const save = debounce(() => saveNow(), 400);
function rememberPosition() { if (G.S && E.cur) G.S.last = { track: E.cur, t: +E.songTime().toFixed(2) }; }
addEventListener('pagehide', () => { rememberPosition(); saveNow(true); });

// ───────────────────────────────────────────── loading: the album lifecycle
// G.phase is always one of:
//   starting  reading the album list
//   empty     there are no albums (showEmpty)
//   loading   an album's data and saved state are on their way: nothing renders, plays or saves
//   ready     G.data and G.S belong to G.aid, and every change is saved to it
// openAlbum() is the only way into loading and out of it. Each call takes a ticket; a load that a newer one
// overtook (a second click before the first album arrived) stops where it is, so the latest album wins and one
// album's notes are never saved under another album's name.
async function init() {
  tooltips();
  applyTheme(PREFS.theme);
  $('#cmdKey').textContent = `${MOD} K`; $('#openCmd').dataset.key = `${MOD} K`; $('#undoBtn').dataset.key = `${MOD} Z`;
  paintStatic();
  try {
    const h = await api.json('/api/health'); G.version = h.version; $('#ver').textContent = 'v' + h.version;
    G.albums = await api.json('/api/albums');
  } catch { G.albums = []; }
  if (!G.albums.length) return showEmpty();
  const fromHash = parseHash(), last = store.get('album', null);
  const aid = [fromHash?.aid, last, G.albums[0].id].find(id => G.albums.some(a => a.id === id));
  await openAlbum(aid, { trackN: fromHash?.aid === aid ? fromHash.n : null });
}

async function openAlbum(aid, { trackN = null } = {}) {
  const ticket = ++G.ticket, was = G.phase === 'ready' ? G.aid : null;
  if (was) { rememberPosition(); save.flush(); }       // the album you're leaving, saved while it's still in place
  G.phase = 'loading';
  seq.reset(); E.unload(); G.sel = null; editing = null;
  G.aid = aid; store.set('album', aid);
  let data, st = {};
  try { data = await api.json(`/data/${enc(aid)}.json`); }
  catch (err) {
    if (ticket !== G.ticket) return;
    if (!was || was === aid) throw err;
    toast(`Couldn’t open that album. Rebuild its data with: python app/build_data.py ${aid}`, { ms: 8000 });
    return openAlbum(was);
  }
  try { st = DEMO ? store.get(`demo.${aid}`, {}) || {} : await api.json(`/api/state?album=${enc(aid)}`); } catch {}
  if (ticket !== G.ticket) return;                        // another album was opened meanwhile: it wins
  G.data = data;
  G.byName = {}; G.data.tracks.forEach(t => (G.byName[t.name] = t));
  G.defaultOrder = G.data.tracks.map(t => t.name);
  G.undo = []; G.redo = [];
  const fresh = FRESH();
  G.S = { ...fresh, ...st, settings: { ...fresh.settings, ...(st.settings || {}) } };
  for (const k of ['notes', 'marks', 'status', 'titles', 'isrc', 'fixes']) G.S[k] = G.S[k] && typeof G.S[k] === 'object' ? G.S[k] : {};
  applyFixes();
  pad.render();
  // keep the saved order, drop tracks that are gone, add new ones at the end
  G.S.order = (G.S.order || []).filter(n => G.byName[n]);
  G.defaultOrder.forEach(n => { if (!G.S.order.includes(n)) G.S.order.push(n); });
  const s = G.S.settings;
  $('#cont').checked = s.cont; $('#gap').value = String(s.gap); $('#tlen').value = String(s.tlen); $('#albumNotes').value = G.S.albumNotes || '';
  E.setMode(s.mode); E.setMatch(s.match); E.setVolume(PREFS.volume); E.setSide('B');
  const byN = trackN && G.data.tracks.find(t => String(t.n) === String(trackN));
  const last = G.S.last && G.byName[G.S.last.track] ? G.S.last : null;
  G.sel = byN?.name || last?.track || G.S.order[0];
  if (last && (!byN || byN.name === last.track)) E.load(last.track, { at: last.t });     // pick up where you left off (paused)
  G.phase = 'ready';
  if (DEMO) $('#demoWhat').textContent = `${G.data.title}${G.data.artist ? ' by ' + G.data.artist : ''}`;
  renderAll();
  pollJobs();
  $('#main').scrollTop = 0;
  if (G.sel !== G.S.order[0]) $(`.row[data-name="${CSS.escape(G.sel)}"]`)?.scrollIntoView({ block: 'nearest' });
}

function showEmpty() {
  G.phase = 'empty';
  $('#albumTitle').textContent = 'No albums yet';
  $('#page').innerHTML = `<div class="empty card"><b>Build the album data first</b>GODMIX reads the albums listed in <code>albums.json</code> (the demo) and <code>local/albums.json</code> (yours).<br><br>
    Run <code>python app/build_data.py</code> from the repo folder, then reload this page.<br>See README.md for the full setup.</div>`;
  renderPlayer();
}

// ───────────────────────────────────────────── rendering
function renderAll() { renderSide(); renderHeader(); renderList(); renderInspector(); renderPlayer(); drawAll(); syncHash(); }

function paintStatic() {
  $('#openCmd .ico').outerHTML = ICON.search;
  $('#helpBtn').innerHTML = ICON.keyboard; $('#inspBtn').innerHTML = ICON.panel;
  $('#prevBtn').innerHTML = ICON.prev; $('#nextBtn').innerHTML = ICON.next;
  $('#undoBtn').innerHTML = ICON.undo + 'Undo';
  $('#copyBtn').innerHTML = ICON.copy + 'Tracklist'; $('#padBtn').innerHTML = ICON.pad + 'Notes'; $('#resetBtn').innerHTML = ICON.reset + 'Reset';
  $('#addAlbum').innerHTML = ICON.plus; $('#copyNotes').innerHTML = ICON.copy + 'Copy all';
  $('#exportBtn').innerHTML = ICON.ext + 'Export';
  $('#showTrans').checked = PREFS.trans;
  setInspector(PREFS.insp, false);
}

function renderSide() {
  $('#albums').innerHTML = G.albums.map((a, i) => (a.demo && !G.albums[i - 1]?.demo ? '<h3 class="label">Demo</h3>' : '') + `<button class="nav-item${a.id === G.aid ? ' on' : ''}" data-album="${esc(a.id)}">
    <span class="name"><b>${esc(a.title)}</b>${a.subtitle ? ` <span class="dim">${esc(a.subtitle)}</span>` : ''}${a.released ? '' : ' <span class="dim">· in progress</span>'}</span>
    ${a.id === G.aid && !E.paused() ? '<span class="playing-dot"></span>' : `<span class="count">${a.tracks}</span>`}</button>`).join('');
  const f = (folder, sub, label, tip) => `<button class="nav-item" data-folder="${folder}" data-sub="${sub}" data-tip="${tip}">${ICON.folder}<span class="name">${label}</span></button>`;
  $('#folders').innerHTML = !G.data || DEMO ? '' : G.data.released
    ? f('orig', '', 'Album files', 'The released album WAVs (never changed)') + f('versions', '', 'Versions', 'Slowed, sped up and other versions')
    : f('orig', '', 'Originals', 'Your original mixes') + f('master', '24', 'Masters 24-bit', '24-bit masters for distribution') +
      f('master', '16', 'Masters 16-bit', '16-bit CD-quality masters') + f('versions', '', 'Versions', 'Slowed, sped up and other versions');
}

function startTimes() {
  const st = {}; let t = 0;
  G.S.order.forEach(n => { st[n] = t; t += track(n).dur + gap(); });
  return { st, total: Math.max(0, t - gap()) };
}

function renderHeader() {
  const d = G.data, { total } = startTimes(), nv = d.tracks.reduce((s, t) => s + (t.versions?.length || 0), 0);
  const done = G.S.order.filter(n => G.S.status[n] === 'done').length;
  $('#crumbAlbum').textContent = d.title + (d.subtitle ? ' ' + d.subtitle : '');
  $('#albumTitle').innerHTML = esc(d.title) + (d.subtitle ? ` <span class="sub">${esc(d.subtitle)}</span>` : '') + (d.artist ? `<small>by ${esc(d.artist)}</small>` : '');
  $('#albumMeta').innerHTML = [`${G.S.order.length} tracks`, fmtLong(total), `${gap()} s gaps`, nv ? `${nv} versions` : '', d.released ? 'released' : 'mastering',
    done ? `${done}/${G.S.order.length} approved` : ''].filter(Boolean).map(x => `<span>${x}</span>`).join('');
  $('#undoBtn').disabled = !G.undo.length; $('#undoBtn').style.opacity = G.undo.length ? 1 : 0.4;
  document.title = `${d.title} · GODMIX`;
}

function rowHTML(n, i, st) {
  const t = track(n), moved = t.n && +t.n !== i + 1, status = G.S.status[n] || '';
  const note = (G.S.notes[n] || '').trim() || (G.S.marks[n] || []).length, isCur = n === E.cur, playing = isCur && !E.paused();
  return `<div class="row${n === G.sel ? ' sel' : ''}${isCur ? ' cur' : ''}${playing ? ' playing' : ''}" draggable="true" data-name="${esc(n)}" role="option" aria-selected="${n === G.sel}">
    <button class="status ${status}" data-act="status" data-tip="${STATUS[status].label}" data-key="S">${STATUS[status].icon}</button>
    <span class="pos">${isCur ? '<span class="eq"><i></i><i></i><i></i></span>' : pad2(i + 1)}</span>
    <div class="t"><b>${esc(pretty(n))}</b>${moved ? `<span class="was" data-tip="Track ${t.n} on the album">was ${t.n}</span>` : ''}${note ? '<span class="note-dot" data-tip="Has notes"></span>' : ''}</div>
    <div class="facts">
      ${t.versions?.length ? `<span class="chip hide-sm" data-tip="${esc(t.versions.map(v => v.label).join(' · '))}">+${t.versions.length}</span>` : ''}
      <span class="mono hide-sm">${fmt(st[n])}</span>
      <span class="mono">${Math.round(t.bpm)}<span class="dim"> bpm</span></span>
      <span class="mono key hide-sm${t.key_sure ? '' : ' unsure'}" data-tip="${esc(t.key)}${t.key_sure ? '' : ' (low-confidence reading)'}">${esc(t.camelot)}${t.key_sure ? '' : '?'}</span>
      <span class="mono">${fmt(t.dur)}</span>
      <span class="acts"><button class="btn icon" data-act="up" data-tip="Move up" data-key="Alt ↑">${ICON.up}</button><button class="btn icon" data-act="down" data-tip="Move down" data-key="Alt ↓">${ICON.down}</button><button class="btn icon" data-act="menu" data-tip="More">${ICON.more}</button></span>
    </div></div>`;
}
function renderList() {
  const { st } = startTimes(), L = $('#list');
  L.classList.toggle('compact', !PREFS.trans);
  L.innerHTML = G.S.order.map((n, i) => rowHTML(n, i, st) + (i < G.S.order.length - 1 ? `<div class="trans"><span class="tchips">${transitionChips(track(n), track(G.S.order[i + 1]))
    .map(([k, l]) => `<span class="chip ${k}">${esc(l)}</span>`).join('')}</span><button class="btn" data-trans="${i}">${ICON.play}Hear transition</button></div>` : '')).join('');
}
const markRows = () => $$('.row').forEach(r => { const n = r.dataset.name, isCur = n === E.cur;
  r.classList.toggle('sel', n === G.sel); r.classList.toggle('cur', isCur); r.classList.toggle('playing', isCur && !E.paused()); r.setAttribute('aria-selected', n === G.sel); });

function renderInspector() {
  const n = G.sel, t = n && track(n), el = $('#inspector');
  if (!t) { el.innerHTML = '<div class="insp empty">Select a track</div>'; return; }
  const { st } = startTimes(), i = G.S.order.indexOf(n), status = G.S.status[n] || '', isCur = n === E.cur;
  const verOn = isCur ? (E.ver?.label || '') : null, marks = (G.S.marks[n] || []).slice().sort((a, b) => a.t - b.t);
  const edge = edgeSummary(t);
  // correcting this track's analysis: what's typed so far survives the panel being redrawn (a version finishing, a play)
  const draft = editing === n ? $$('#inspector [data-fix]').map(x => [x.dataset.fix, x.value, x === document.activeElement]) : [];
  const vrow = (label, k, meta, on) => `<button class="vrow${on ? ' on' : ''}" data-ver="${esc(label)}"><span class="k"><kbd>${k}</kbd><span>${esc(label || (G.data.released ? 'Album version' : 'Album master'))}</span></span><span class="mono">${meta}</span><span class="mono">${on && !E.paused() ? '▶' : ''}</span></button>`;
  el.innerHTML = `<div class="insp">
    <div class="over"><button class="status ${status}" data-act="status" data-tip="${STATUS[status].label}" data-key="S">${STATUS[status].icon}</button>
      <span class="label">Track ${pad2(i + 1)}${t.n && +t.n !== i + 1 ? ` · album #${t.n}` : ''}</span></div>
    <h2 data-rename data-tip="Double-click to rename" data-key="F2">${esc(pretty(n))}</h2>${G.S.titles[n] ? `<div class="renamed dim">Album title: ${esc(t.title)}</div>` : ''}
    <canvas class="mini" id="mini" data-tip="Click to play from here"></canvas>
    ${analysisHTML(n, t, st, edge)}
    <section><div class="label"><span>Versions</span><span>${isCur ? '' : 'click to play'}</span></div><div class="vlist">
      ${vrow('', 0, `${Math.round(t.bpm)} bpm · ${fmt(t.dur)}`, verOn === '')}
      ${(t.versions || []).map((v, k) => { const semis = 12 * Math.log2(v.speed);
        return vrow(v.label, k + 1, `${Math.round(t.bpm * v.speed)} bpm${Math.abs(semis) > 0.05 ? ` · ${semis > 0 ? '+' : ''}${semis.toFixed(1)} st` : ''} · ${fmt(v.dur)}`, verOn === v.label); }).join('')}
      ${missingVersions(t).map(l => { const j = jobFor(n, l);
        return `<button class="vrow make${j ? ' busy' : ''}" data-make="${esc(l)}" ${j ? 'disabled' : ''} data-tip="${DEMO ? 'Installed, GODMIX designs it from the song’s measurements and renders it' : 'Design it from the song’s measurements and render it'}"><span class="k"><kbd>+</kbd><span>${esc(l)}</span></span><span class="mono">${j ? (j.status === 'queued' ? 'waiting…' : `making… ${Math.round(j.p * 100)}%`) : DEMO ? 'in the app' : 'make it'}</span><span></span></button>`; }).join('')}
      <button class="vrow make trace" data-trace data-tip="A tagged copy for each person you send it to. If one leaks, trace the source" data-key="R"><span class="k"><span class="tt-ico">${ICON.trace}</span><span>Trace Tags…</span></span><span class="mono">${DEMO ? 'in the app' : 'for sending'}</span><span></span></button>
    </div></section>
    <section><div class="label"><span>Marks</span><span>${marks.length || ''}</span></div>
      <form class="addmark" id="markForm"><input class="field" id="markInput" placeholder="Note at ${fmt(isCur ? E.songTime() : 0)} · press N while playing" autocomplete="off"><button class="btn line" type="submit">Add</button></form>
      <div class="marks">${marks.map(m => `<div class="mark" data-t="${m.t}"><span class="at" data-jump="${m.t}" data-tip="Play from here">${fmt(m.t)}</span><span class="txt">${esc(m.text)}</span><button class="x" data-unmark="${m.t}" data-tip="Delete">${ICON.close}</button></div>`).join('')}</div>
    </section>
    <section><div class="label">Notes</div><textarea class="field" id="trackNotes" rows="4" placeholder="Notes for ${esc(pretty(n))}…">${esc(G.S.notes[n] || '')}</textarea></section>
    ${DEMO ? '' : `<section><div class="label">Files</div><div class="filebtns">
      <button class="btn line" data-reveal="master">${ICON.file}${G.data.released ? 'Album file' : 'Master'}</button>
      ${G.data.released ? '' : `<button class="btn line" data-reveal="orig">${ICON.file}Original</button>`}
      ${(t.versions || []).length ? `<button class="btn line" data-reveal="version">${ICON.file}${isCur && E.ver ? esc(E.ver.label) : 'Version'}</button>` : ''}
    </div></section>`}</div>`;
  for (const [k, v, had] of draft) { const x = $(`#inspector [data-fix="${k}"]`); if (x) { x.value = v; if (had) x.focus(); } }
  drawMini();
}

// ───────────────────────────────────────────── analysis: measured by build_data.py, correctable by hand
const NOTES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const CAM = { major: [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1], minor: [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10] };
const KEYS = NOTES.flatMap(nn => [`${nn} major`, `${nn} minor`]);
const camelotOf = key => { const [nn, mode] = key.split(' '); return `${CAM[mode][NOTES.indexOf(nn)]}${mode === 'major' ? 'B' : 'A'}`; };
// [field, label, unit, step, read from a track]
const FIELDS = [['bpm', 'Tempo', 'bpm', 0.1, t => t.bpm], ['key', 'Key', '', 0, t => t.key], ['I', 'Loudness', 'LUFS', 0.1, t => t.after.I],
  ['loud', 'Loud section', 'LUFS', 0.1, t => t.after.loud], ['LRA', 'Range', 'LU', 0.1, t => t.after.LRA], ['TP', 'True peak', 'dBTP', 0.1, t => t.after.TP],
  ['bright_hz', 'Brightness', 'Hz', 1, t => t.bright_hz], ['start_lufs', 'Starts', 'LUFS', 0.1, t => t.start_lufs], ['end_lufs', 'Ends', 'LUFS', 0.1, t => t.end_lufs]];
// Put the corrections over the measurements (keeping the measured values, to show and to reset to).
function applyFixes() {
  for (const t of G.data.tracks) {
    t._measured ||= { bpm: t.bpm, key: t.key, camelot: t.camelot, key_sure: t.key_sure, after: { ...t.after }, bright_hz: t.bright_hz, start_lufs: t.start_lufs, end_lufs: t.end_lufs };
    const m = t._measured, f = G.S.fixes[t.name] || {};
    Object.assign(t, { bpm: f.bpm ?? m.bpm, key: f.key ?? m.key, key_sure: f.key ? true : m.key_sure, bright_hz: f.bright_hz ?? m.bright_hz,
      start_lufs: f.start_lufs ?? m.start_lufs, end_lufs: f.end_lufs ?? m.end_lufs });
    t.camelot = f.key ? camelotOf(f.key) : m.camelot;
    t.after = { ...m.after, ...Object.fromEntries(['I', 'loud', 'LRA', 'TP'].filter(k => f[k] != null).map(k => [k, f[k]])) };
  }
}
// The analysis panel is viewing (editing = null) or correcting one track (editing = its id). Edit, Cancel, Save,
// Reset, Enter and Esc move between the two; selecting another track or opening another album cancels.
let editing = null;
function analysisHTML(n, t, st, edge = '') {
  const f = G.S.fixes[n] || {}, ed = editing === n, edited = Object.keys(f).length;
  const val = ([k, , unit, , get]) => k === 'key' ? `${esc(t.camelot)} · ${esc(t.key)}${t.key_sure ? '' : '?'}` : k === 'bpm' ? `${get(t).toFixed(1)} ${unit}`
    : k === 'bright_hz' ? `${get(t)} ${unit}` : `${(+get(t)).toFixed(1)} ${unit}`;
  const input = ([k, , unit, step, get]) => k === 'key'
    ? `<select class="select fix" data-fix="key">${KEYS.map(x => `<option${x === t.key ? ' selected' : ''}>${x}</option>`).join('')}</select>`
    : `<span class="fixwrap"><input class="field fix mono" data-fix="${k}" type="number" step="${step}" value="${get(t)}"><span class="dim">${unit}</span></span>`;
  return `<section><div class="label"><span>Analysis${edited && !ed ? ' <span class="edited-n">· ' + edited + ' corrected</span>' : ''}</span>
      ${ed ? `<span class="fixbtns"><button class="btn" data-fixact="reset" data-tip="Back to what GODMIX measured">Reset</button><button class="btn" data-fixact="cancel">Cancel</button><button class="btn solid" data-fixact="save">Save</button></span>`
        : `<button class="btn" data-fixact="edit" data-tip="Correct a tempo, key or level">Edit</button>`}</div>
    <p class="analysis-note">Measured automatically, so it can be off: a tempo at half or double speed, or a key's relative major or minor. Correct anything here; your values are displayed everywhere in GODMIX.</p>
    <dl class="props${ed ? ' editing' : ''}">
      <dt>Length</dt><dd data-tip="Read from the file">${fmt(t.dur)}</dd><dt>Starts at</dt><dd data-tip="From your running order and gaps">${fmtLong(st[n])}</dd>
      ${FIELDS.map(F => `<dt>${F[1]}${f[F[0]] != null && !ed ? '<i class="fixdot" data-tip="Corrected by hand"></i>' : ''}</dt><dd>${ed ? input(F) : val(F)}</dd>`).join('')}
      ${G.data.released || ed ? '' : `<dt>Original</dt><dd>${t.before.I.toFixed(1)} LUFS (${(t.after.I - t.before.I >= 0 ? '+' : '')}${(t.after.I - t.before.I).toFixed(1)} dB)</dd>`}
    </dl>${edge ? `<div class="edge-note">${esc(edge)}</div>` : ''}</section>`;
}
function fixAction(act) {
  const n = G.sel, t = track(n);
  if (act === 'edit') { editing = n; renderInspector(); $('#inspector [data-fix]')?.focus(); return; }
  if (act === 'cancel') { editing = null; return renderInspector(); }
  if (act === 'reset') { delete G.S.fixes[n]; editing = null; toast(`${pretty(n)}: back to the measured values`); }
  if (act === 'save') {
    const m = t._measured, f = {};
    for (const el of $$('#inspector [data-fix]')) {
      const k = el.dataset.fix, v = k === 'key' ? el.value : parseFloat(el.value);
      if (k !== 'key' && !Number.isFinite(v)) continue;
      const was = k === 'key' ? m.key : k in m.after ? m.after[k] : m[k];
      if (k === 'key' ? v !== was : Math.abs(v - was) > 1e-6) f[k] = v;
    }
    if (Object.keys(f).length) G.S.fixes[n] = f; else delete G.S.fixes[n];
    editing = null; toast(Object.keys(f).length ? `${pretty(n)}: analysis corrected` : 'Nothing changed');
  }
  applyFixes(); save(); renderList(); renderInspector(); renderPlayer(); drawArcNow();
}

const missingVersions = t => (G.data.version_kinds || []).filter(k => !(t.versions || []).some(v => v.label === k));

function renderPlayer() {
  const t = E.cur && track(E.cur), playing = !E.paused() || seq.waiting();
  $('#playBtn').innerHTML = playing ? ICON.pause : ICON.play;
  $('#playBtn').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  if (!t) { $('#npTitle').textContent = 'Nothing playing'; $('#npMeta').textContent = G.data ? 'Pick a track, or press Space' : ''; }
  else {
    const i = G.S.order.indexOf(E.cur), v = E.ver;
    $('#npTitle').textContent = `${pad2(i + 1)}  ${pretty(E.cur)}`;
    const side = v ? (E.side === 'A' ? (G.data.released ? 'Album version' : 'Album master') : v.label) : (G.data.released ? 'Album version' : E.side === 'A' ? 'Original' : 'Master');
    const bpm = Math.round(t.bpm * (v && E.side === 'B' ? v.speed : 1));
    $('#npMeta').textContent = `${side} · ${bpm} bpm · ${(v && E.side === 'B' ? v.I : E.side === 'A' && !v ? t.before.I : t.after.I).toFixed(1)} LUFS${E.match && E.side === 'B' && showAB() ? ' · matched' : ''}`;
  }
  // A/B only means something when there are two different files
  const ab = showAB(), v = E.ver;
  $('#ab').hidden = !ab; $('#matchWrap').hidden = !ab;
  $('#ab').innerHTML = ab ? `<button data-side="A" class="${E.side === 'A' ? 'on' : ''}" data-tip="${v ? 'Album master' : 'Original mix'}" data-key="A">A · ${v ? (G.data.released ? 'Album' : 'Master') : 'Original'}</button><button data-side="B" class="${E.side === 'B' ? 'on' : ''}" data-tip="${v ? esc(v.label) : 'Master'}" data-key="B">B · ${v ? esc(shortLabel(v.label)) : 'Master'}</button>` : '';
  $('#match').checked = E.match;
  const vs = t?.versions || [];
  $('#verSel').hidden = !vs.length;
  $('#verSel').innerHTML = [['', G.data?.released ? 'Album version' : 'Album master'], ...vs.map(x => [x.label, x.label])]
    .map(([val, l], k) => `<option value="${esc(val)}"${(E.ver?.label || '') === val ? ' selected' : ''}>${k}  ${esc(l)}</option>`).join('');
  $$('#mode button').forEach(b => b.classList.toggle('on', b.dataset.mode === E.mode));
  $('#vol').value = E.volume; $('#vol').style.setProperty('--v', E.volume * 100 + '%');
  $('#tDur').textContent = fmt(E.dur());
}
const showAB = () => !!E.cur && !(G.data.released && !E.ver);
const shortLabel = l => l.replace('Slowed + Reverb', 'Slowed');

// ───────────────────────────────────────────── drawing (every frame while playing)
let hoverFrac = -1;
function drawPlayer() {
  const cv = $('#wave'), t = E.cur && track(E.cur);
  if (!t) return drawWave(cv, null);
  const d = E.dur(), sp = E.speed();
  drawWave(cv, E.ver || t, {
    pos: E.bTime() / d, hover: hoverFrac,
    loop: E.loop ? { a: E.loop.a / sp / d, b: E.loop.b / sp / d, on: E.loop.on } : null,
    marks: (G.S.marks[E.cur] || []).map(m => m.t / sp / d),
  });
  $('#tCur').textContent = fmt(E.bTime());
}
function drawMini() {
  const cv = $('#mini'), t = track(G.sel); if (!cv || !t) return;
  const isCur = G.sel === E.cur;
  drawWave(cv, isCur && E.ver ? E.ver : t, { pos: isCur ? E.bTime() / E.dur() : -1,
    marks: (G.S.marks[G.sel] || []).map(m => m.t / (isCur ? E.speed() : 1) / (isCur ? E.dur() : t.dur)) });
}
function drawArcNow() {
  if (!G.data) return;
  const { st, total } = startTimes();
  drawArc($('#arc'), { order: G.S.order, byName: G.byName, starts: st, total, cur: E.cur, sel: G.sel, pos: E.cur ? E.songTime() : null });
}
function drawMeter() {
  const [l, r] = E.meter(), w = db => clamp((db + 48) / 48, 0, 1) * 100 + '%';
  for (const [el, db] of [[$('#mL'), l], [$('#mR'), r]]) { el.style.width = w(db); el.className = db > -0.3 ? 'clip' : db > -3 ? 'hot' : ''; }
}
const drawAll = () => { if (G.phase !== 'ready') return; drawPlayer(); drawMini(); drawArcNow(); drawMeter(); };
(function frame() { if (E.cur && (!E.paused() || seq.waiting())) drawAll(); else drawMeter(); requestAnimationFrame(frame); })();
addEventListener('resize', () => G.data && drawAll());
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => G.data && drawAll());

// ───────────────────────────────────────────── transport
function onChange(kind) {
  if (G.phase !== 'ready') return;
  if (['load', 'play', 'pause', 'side', 'match', 'mode', 'volume', 'error'].includes(kind)) renderPlayer();
  if (['load', 'play', 'pause'].includes(kind)) { markRows(); renderSide(); updateMedia(); }
  if (kind === 'load') { renderList(); if (G.sel === E.cur) renderInspector(); preloadNext(); }
  if (kind === 'pause') { rememberPosition(); save(); }
  if (kind === 'error') toast(`Couldn’t play ${pretty(E.cur)}. Is the file still there? Rebuild the data if it moved.`);
  if (kind === 'preview-end') seq.previewEnded();
  if (kind !== 'volume') drawAll();
}
// Start a song from the top (or `at`). Anything pending between songs is dropped: you've chosen what plays.
function play(n, opts = {}) {
  if (G.phase !== 'ready' || !track(n)) return false;
  seq.reset();
  if (opts.select !== false) select(n, { scroll: true });
  E.load(n, { play: true, ...opts });
  return true;
}
// Space, the play button and the media keys. Between songs, pausing holds the gap and playing goes straight on.
function togglePlay() {
  if (seq.toggle()) return;
  if (!E.cur) { play(G.sel || G.S.order[0]); return; }
  E.toggle();
}
const resume = () => G.phase === 'ready' && (seq.resume() || (E.cur ? E.play() : togglePlay()));
const pause = () => seq.pause() || E.pause();
function step(d) {
  const i = G.S.order.indexOf(E.cur ?? G.sel), j = i + d;
  if (j >= 0 && j < G.S.order.length) play(G.S.order[j]);
}
// Keep the next song buffered on the engine's standby pair, so play-through and Next start instantly.
function nextName() { const i = G.S.order.indexOf(E.cur); return i >= 0 && i < G.S.order.length - 1 ? G.S.order[i + 1] : null; }
function preloadNext() { const n = seq.upcoming() || nextName(); if (n) E.preload(n, null); }
// Gapless: with a 0 s gap, start the next song a hair before this one ends instead of waiting for 'ended'.
setInterval(() => {
  if (G.phase !== 'ready' || !E.cur || E.paused() || gap() > 0 || E.loop?.on) return;
  if (seq.autoNext() && E.remaining() < 0.03) onEnded();
}, 10);
function onEnded() { seq.ended(); }
function previewTransition(i) {
  const a = G.S.order[i], b = G.S.order[i + 1], len = +G.S.settings.tlen;
  if (!a || !b) return;
  play(a, { at: Math.max(0, track(a).dur - len) });
  seq.preview(b, len); preloadNext();
}
function setVersion(label) {
  const n = G.sel || E.cur; if (!n) return;
  const t = track(n); if (!t) return;
  const next = label ? (t.versions || []).find(v => v.label === label) : null;
  if (label && !next) return;
  if (n !== E.cur) return play(n, { version: next });
  const song = E.songTime(), wasPlaying = !E.paused();     // stay at the same spot in the song
  const keepLoop = E.loop;
  E.load(n, { at: next ? Math.min(song / next.speed, next.dur - 0.5) : song, play: wasPlaying, version: next });
  E.loop = keepLoop;
  if (!showAB()) E.setSide('B');
  renderInspector(); renderPlayer();
}
function versionByIndex(k) {
  const n = G.sel || E.cur, vs = track(n)?.versions || [];
  if (k === 0) setVersion(''); else if (vs[k - 1]) setVersion(vs[k - 1].label);
}
function setSide(s) { if (!showAB()) return; E.setSide(s); }

// ───────────────────────────────────────────── selection, order and undo
function select(n, { scroll = false } = {}) {
  if (!n || !track(n)) return;
  const changed = n !== G.sel;
  if (changed && editing) editing = null;          // correcting one track's analysis ends when you move to another
  G.sel = n; markRows();
  if (changed) { renderInspector(); drawArcNow(); syncHash(); }
  if (scroll) $(`.row[data-name="${CSS.escape(n)}"]`)?.scrollIntoView({ block: 'nearest' });
}
function moveSel(d) { const i = G.S.order.indexOf(G.sel); select(G.S.order[clamp(i + d, 0, G.S.order.length - 1)], { scroll: true }); }
function setOrder(order, label) {
  G.undo.push({ order: [...G.S.order], label }); G.undo = G.undo.slice(-100); G.redo = [];
  G.S.order = order; save(); renderHeader(); renderList(); renderInspector(); drawArcNow(); renderPlayer(); preloadNext();
}
function move(n, to) {
  const from = G.S.order.indexOf(n); if (from < 0 || to < 0 || to >= G.S.order.length || from === to) return;
  const o = [...G.S.order]; o.splice(from, 1); o.splice(to, 0, n);
  setOrder(o, `Moved ${pretty(n)}`);
  $(`.row[data-name="${CSS.escape(n)}"]`)?.scrollIntoView({ block: 'nearest' });
}
function undo() {
  const u = G.undo.pop(); if (!u) return toast('Nothing to undo');
  G.redo.push({ order: [...G.S.order], label: u.label }); G.S.order = u.order; save(); renderHeader(); renderList(); renderInspector(); drawArcNow();
  toast(`Undid: ${u.label}`, { action: 'Redo', onAction: redo });
}
function redo() {
  const r = G.redo.pop(); if (!r) return toast('Nothing to redo');
  G.undo.push({ order: [...G.S.order], label: r.label }); G.S.order = r.order; save(); renderHeader(); renderList(); renderInspector(); drawArcNow();
}
function resetOrder() {
  if (G.S.order.join('|') === G.defaultOrder.join('|')) return toast('Already in the album’s order');
  setOrder([...G.defaultOrder], 'Reset order');
  toast('Back to the album’s order', { action: 'Undo', onAction: undo });
}
function cycleStatus(n = G.sel) {
  const s = G.S.status[n] || '', next = STATUS_ORDER[(STATUS_ORDER.indexOf(s) + 1) % STATUS_ORDER.length];
  setStatus(n, next);
}
function setStatus(n, s) {
  if (s) G.S.status[n] = s; else delete G.S.status[n];
  save(); renderList(); renderHeader(); if (n === G.sel) renderInspector();
  toast(`${pretty(n)}: ${STATUS[s].label}`);
}

// ───────────────────────────────────────────── renaming (shown everywhere, used in exports)
function setTitle(n, v, { quiet = false } = {}) {
  const before = G.S.titles[n];
  v = (v || '').trim();
  if (!v || v === track(n).title) delete G.S.titles[n]; else G.S.titles[n] = v;
  save();
  if (quiet) { const b = $(`.row[data-name="${CSS.escape(n)}"] .t b`); if (b) b.textContent = pretty(n); return; }
  renderList(); renderInspector(); renderPlayer(); updateMedia();
  if (before !== G.S.titles[n]) toast(`Renamed to ${pretty(n)}`, { action: 'Undo', onAction: () => setTitle(n, before || track(n).title) });
}
function rename(n = G.sel) {
  const b = n && $(`.row[data-name="${CSS.escape(n)}"] .t b`); if (!b) return;
  select(n);
  const inp = document.createElement('input');
  inp.className = 'field rename'; inp.value = pretty(n); inp.spellcheck = false;
  b.replaceWith(inp); inp.focus(); inp.select();
  let done = false;
  const finish = ok => { if (done) return; done = true; if (ok) setTitle(n, inp.value); else renderList(); };
  inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); });
  inp.addEventListener('blur', () => finish(true));
  inp.addEventListener('click', e => e.stopPropagation());
}

// ───────────────────────────────────────────── jobs (making versions, exports) run by the server
// Each job goes queued → running → done | error on the server, or 'gone' here if the server restarted under it
// (jobwatch.mjs). The list is polled while any job is live; every finish is reported once, by finished().
const JOBS = { list: [], timer: null, offline: false, waiters: new Map(), poll: 0 };
const watch = createJobWatch();
const jobFor = (n, label) => JOBS.list.find(j => j.kind === 'make' && j.album === G.aid && isLive(j) && (!j.tracks.length || j.tracks.includes(n)) && (!j.versions.length || j.versions.includes(label)));
async function startJob(body) {
  try {
    const r = await api.post('/api/jobs', body), j = await r.json();
    if (!r.ok) return toast(`Couldn’t start that: ${j.error || r.status}`);
    watch.saw(j);
    toast(`${j.label}… progress is in the sidebar`);
    pollJobs();
  } catch { toast('Couldn’t reach the GODMIX server'); }
}
// a job started elsewhere (Trace Tags' Check a leak): resolves with the job once it has finished, its status
// 'done', 'error' or 'gone'
function waitJob(j) {
  return new Promise(resolve => { watch.saw(j); JOBS.waiters.set(j.id, resolve); pollJobs(); });
}
function makeVersions(tracks, versions) { if (DEMO) return needsInstall('Making versions'); startJob({ kind: 'make', album: G.aid, tracks, versions }); }
async function pollJobs() {
  clearTimeout(JOBS.timer);
  if (DEMO) return;
  const n = ++JOBS.poll;                          // only the latest poll's answer counts; an older one arriving late is dropped
  let list;
  try { list = await api.json('/api/jobs'); }
  catch {                                         // the server isn't answering: keep trying while a job was running
    if (n !== JOBS.poll) return;
    JOBS.offline = watch.live();
    renderJobs();
    if (JOBS.offline) JOBS.timer = setTimeout(pollJobs, 2000);
    return;
  }
  if (n !== JOBS.poll) return;
  JOBS.list = list; JOBS.offline = false;
  for (const { job, now } of watch.update(JOBS.list)) if (FINISHED.includes(now)) finished(job);
  renderJobs();
  updateMakeRows();
  if (JOBS.list.some(isLive)) JOBS.timer = setTimeout(pollJobs, 700);
}
// what a finished job means for the app: a toast, and new data or a new album where it made some
function finished(j) {
  const w = JOBS.waiters.get(j.id);
  if (w) { JOBS.waiters.delete(j.id); return w(j); }
  if (j.kind === 'trace-check') return;
  if (j.status === 'gone') return toast(`${j.label} stopped: the GODMIX server was restarted. Start it again.`, { ms: 9000 });
  if (j.status === 'error') return toast(`${j.label} failed: ${j.error || 'see the server window'}`, { ms: 9000 });
  if (j.kind === 'make') { toast(j.msg); if (j.album === G.aid) reloadData(); }
  else if (j.kind === 'album') {
    toast(j.msg);
    api.json('/api/albums').then(list => { G.albums = list; if (j.action === 'add' && j.result?.album) openAlbum(j.result.album); else if (j.album === G.aid) reloadData(); else if (G.phase === 'ready') renderSide(); }).catch(() => {});
  }
  else toast(j.msg, { action: 'Show folder', onAction: () => api.post('/api/open', { job: j.id }), ms: 9000 });
}
// refresh the "make it" rows in place (re-rendering the panel would steal focus from the notes)
function updateMakeRows() {
  $$('.vrow.make[data-make]').forEach(r => {
    const j = jobFor(G.sel, r.dataset.make), m = r.querySelector('.mono');
    r.disabled = !!j; r.classList.toggle('busy', !!j);
    m.textContent = j ? (j.status === 'queued' ? 'waiting…' : `making… ${Math.round(j.p * 100)}%`) : DEMO ? 'in the app' : 'make it';
  });
}
function renderJobs() {
  const live = JOBS.list.filter(isLive);
  const el = $('#jobs');
  el.hidden = !live.length;
  el.innerHTML = live.map(j => `<div class="job"><div class="job-hd"><b>${esc(j.label)}</b><span class="mono">${j.status === 'queued' ? 'waiting' : Math.round(j.p * 100) + '%'}</span></div>
    <div class="bar"><i style="width:${Math.round(j.p * 100)}%"></i></div><div class="job-msg">${esc(JOBS.offline ? 'Can’t reach the GODMIX server. Is it still running?' : j.msg || '')}</div></div>`).join('');
}
// new versions landed: re-read this album's data without losing your place
async function reloadData() {
  if (G.phase !== 'ready') return;
  const ticket = G.ticket;
  let d;
  try { d = await api.json(`/data/${enc(G.aid)}.json`); } catch { return toast('Couldn’t re-read the album data. Reload the page.'); }
  if (ticket !== G.ticket || G.phase !== 'ready') return;          // another album was opened meanwhile
  G.data = d; G.byName = {}; d.tracks.forEach(t => (G.byName[t.name] = t)); G.defaultOrder = d.tracks.map(t => t.name); applyFixes();
  G.S.order = G.S.order.filter(n => G.byName[n]); d.tracks.forEach(t => { if (!G.S.order.includes(t.name)) G.S.order.push(t.name); });
  if (E.ver) E.ver = track(E.cur)?.versions?.find(v => v.label === E.ver.label) || E.ver;
  try { const list = await api.json('/api/albums'); if (ticket === G.ticket) G.albums = list; } catch {}
  if (ticket !== G.ticket || G.phase !== 'ready') return;
  renderSide(); renderHeader(); renderList(); renderInspector(); renderPlayer(); drawAll();
}

// ───────────────────────────────────────────── marks (timestamped notes)
function addMark(n, t, text) {
  text = text.trim(); if (!text) return;
  (G.S.marks[n] ||= []).push({ t: +t.toFixed(2), text });
  save(); renderInspector(); renderList(); drawAll();
}
function removeMark(n, t) {
  const before = G.S.marks[n] || [], gone = before.find(m => m.t === t);
  G.S.marks[n] = before.filter(m => m !== gone); if (!G.S.marks[n].length) delete G.S.marks[n];
  save(); renderInspector(); renderList(); drawAll();
  toast('Mark deleted', { action: 'Undo', onAction: () => { (G.S.marks[n] ||= []).push(gone); save(); renderInspector(); renderList(); drawAll(); } });
}
let markAt = 0;
function startMark() {
  if (!E.cur) return toast('Play a track first, then press N to mark a moment');
  markAt = E.songTime(); select(E.cur); setInspector(true);
  const inp = $('#markInput'); inp.placeholder = `Note at ${fmt(markAt)}, then Enter`; inp.dataset.at = markAt; inp.focus();
}
function jumpSong(n, t) { if (n === E.cur) { E.seekSong(t); if (E.paused()) E.play(); } else { play(n); E.seekSong(t); } }

// ───────────────────────────────────────────── exports
async function copyText(txt, msg) { try { await navigator.clipboard.writeText(txt); toast(msg); } catch { toast('Couldn’t copy to the clipboard'); } }
const clock = s => { s = Math.floor(s); return s >= 3600 ? fmtLong(s) : `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
function copyTracklist() {
  const { st } = startTimes();
  copyText(G.S.order.map((n, i) => `${i + 1}. ${pretty(n)} ${clock(st[n])} - ${clock(st[n] + track(n).dur)}`).join('\n'), 'Tracklist copied, with start and end times');
}
function copyNotes() {
  const d = G.data, lines = [`# ${d.title}${d.artist ? ' by ' + d.artist : ''}: mix notes`, ''];
  if (G.S.albumNotes?.trim()) lines.push('## The album', '', G.S.albumNotes.trim(), '');
  G.S.order.forEach((n, i) => {
    const note = (G.S.notes[n] || '').trim(), marks = (G.S.marks[n] || []).slice().sort((a, b) => a.t - b.t), s = G.S.status[n];
    if (!note && !marks.length && !s) return;
    lines.push(`## ${i + 1}. ${pretty(n)}${s ? ` (${STATUS[s].label.toLowerCase()})` : ''}`, '');
    if (note) lines.push(note, '');
    marks.forEach(m => lines.push(`- ${fmt(m.t)}: ${m.text}`));
    if (marks.length) lines.push('');
  });
  if (lines.length <= 2) return toast('No notes or marks yet');
  copyText(lines.join('\n').trim() + '\n', 'Mix notes copied as Markdown, with every song’s notes and marks');
}
const openFolder = body => DEMO ? needsInstall('Opening folders') : api.post('/api/open', { album: G.aid, ...body }).then(r => toast(r.ok ? 'Opened in your file manager' : 'Couldn’t open that')).catch(() => toast('Couldn’t reach the GODMIX server'));
function reveal(where) {
  const n = G.sel; if (!n) return;
  const version = where === 'version' ? (n === E.cur && E.ver ? E.ver.label : track(n).versions?.[0]?.label) : undefined;
  openFolder({ track: n, where, version });
}

// ───────────────────────────────────────────── theme, panel, url, media keys
function applyTheme(t) { if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; }
function toggleTheme() {
  const now = document.documentElement.dataset.theme || 'dark', next = now === 'dark' ? 'light' : 'dark';
  PREFS.theme = next; store.set('theme', next); applyTheme(next);
  $('#themeBtn').innerHTML = next === 'dark' ? ICON.sun : ICON.moon; drawAll();
}
function setInspector(on, persist = true) {
  PREFS.insp = on; if (persist) store.set('insp', on);
  const s = $('#shell');
  s.classList.toggle('no-insp', !on); s.classList.toggle('insp-open', on);
  $('#inspBtn').setAttribute('aria-pressed', on);
  $('#themeBtn').innerHTML = (document.documentElement.dataset.theme || 'dark') === 'dark' ? ICON.sun : ICON.moon;
  requestAnimationFrame(() => G.data && drawAll());
}
function setTransitions(on) { PREFS.trans = on; store.set('trans', on); $('#showTrans').checked = on; $('#list').classList.toggle('compact', !on); }
function parseHash() { const m = /^#\/([^/]+)(?:\/(\d+))?/.exec(location.hash); return m ? { aid: decodeURIComponent(m[1]), n: m[2] } : null; }
function syncHash() { const t = G.sel && track(G.sel); history.replaceState(null, '', `#/${enc(G.aid)}${t?.n ? '/' + t.n : ''}`); }
addEventListener('hashchange', () => { const h = parseHash(); if (!h) return;
  if (h.aid !== G.aid && G.albums.some(a => a.id === h.aid)) openAlbum(h.aid, { trackN: h.n });
  else if (h.n && G.phase === 'ready') { const t = G.data.tracks.find(x => String(x.n) === h.n); if (t) select(t.name, { scroll: true }); } });
function updateMedia() {
  if (!('mediaSession' in navigator) || !E.cur) return;
  navigator.mediaSession.metadata = new MediaMetadata({ title: pretty(E.cur) + (E.ver ? ` (${E.ver.label})` : ''), artist: G.data.artist || '',
    album: G.data.title, artwork: [{ src: '/assets/icon-512.png', sizes: '512x512', type: 'image/png' }] });
  navigator.mediaSession.playbackState = E.paused() ? 'paused' : 'playing';
}
if ('mediaSession' in navigator) {
  const h = { play: () => resume(), pause: () => pause(), previoustrack: () => step(-1), nexttrack: () => step(1),
    seekto: e => E.seek(e.seekTime), seekbackward: () => E.nudge(-5), seekforward: () => E.nudge(5) };
  for (const [k, fn] of Object.entries(h)) try { navigator.mediaSession.setActionHandler(k, fn); } catch {}
}

// ───────────────────────────────────────────── events
$('#albums').addEventListener('click', e => { const b = e.target.closest('[data-album]'); if (b && b.dataset.album !== G.aid) openAlbum(b.dataset.album); });
$('#albums').addEventListener('contextmenu', e => {
  const b = e.target.closest('[data-album]'); if (!b) return; e.preventDefault();
  cmd.menu([['Edit album…', () => editAlbum(b.dataset.album), '', ICON.edit], ['Open', () => openAlbum(b.dataset.album), '', ICON.album]], e.clientX, e.clientY);
});
const addAlbum = () => (DEMO ? needsInstall('Adding albums') : openAlbumDialog(app, { mode: 'add' }));
$('#addAlbum').onclick = addAlbum;
function editAlbum(id = G.aid) { if (DEMO) return needsInstall('Editing albums'); openAlbumDialog(app, { mode: 'edit', album: G.albums.find(a => a.id === id) }); }
const exportDialog = what => (DEMO ? needsInstall('Exporting') : openExport(app, { what }));
const traceDialog = scope => (DEMO ? needsInstall('Trace Tags') : openTraceTags(app, { scope }));
$('#copyNotes').onclick = () => copyNotes();
$('#folders').addEventListener('click', e => { const b = e.target.closest('[data-folder]'); if (b) openFolder({ folder: b.dataset.folder, sub: b.dataset.sub }); });
$('#list').addEventListener('click', e => {
  const tb = e.target.closest('[data-trans]'); if (tb) return previewTransition(+tb.dataset.trans);
  const row = e.target.closest('.row'); if (!row) return;
  const n = row.dataset.name, act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'status') return cycleStatus(n);
  if (act === 'up') return move(n, G.S.order.indexOf(n) - 1);
  if (act === 'down') return move(n, G.S.order.indexOf(n) + 1);
  if (act === 'menu') { const r = e.target.closest('button').getBoundingClientRect(); return cmd.rowMenu(n, r.right - 200, r.bottom + 4); }
  if (e.target.closest('input')) return;                     // renaming
  if (e.detail > 1) return;                                  // the second click of a double-click: don't undo the first
  // a click plays the song; clicking the one that's playing pauses or resumes it
  if (n === E.cur && !seq.between()) { select(n); togglePlay(); } else play(n);
  pressed(n, e);
});
// a short ripple from where you clicked, so it's clear the click did something
function pressed(n, e) {
  const row = $(`.row[data-name="${CSS.escape(n)}"]`); if (!row) return;
  const r = row.getBoundingClientRect(), dot = document.createElement('span');
  dot.className = 'ripple'; dot.style.left = e.clientX - r.left + 'px'; dot.style.top = e.clientY - r.top + 'px';
  row.append(dot); row.classList.remove('press'); void row.offsetWidth; row.classList.add('press');
  setTimeout(() => dot.remove(), 650);
}
$('#list').addEventListener('contextmenu', e => { const row = e.target.closest('.row'); if (!row) return; e.preventDefault(); select(row.dataset.name); cmd.rowMenu(row.dataset.name, e.clientX, e.clientY); });
let dragName = null;
$('#list').addEventListener('dragstart', e => { const r = e.target.closest('.row'); if (!r) return; dragName = r.dataset.name; r.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragName); });
$('#list').addEventListener('dragend', () => { dragName = null; $$('.row').forEach(r => r.classList.remove('dragging', 'drop-before', 'drop-after')); });
$('#list').addEventListener('dragover', e => {
  if (!dragName) return; e.preventDefault();
  const r = e.target.closest('.row'); $$('.row').forEach(x => x.classList.remove('drop-before', 'drop-after'));
  if (!r || r.dataset.name === dragName) return;
  const b = r.getBoundingClientRect(); r.classList.add(e.clientY < b.top + b.height / 2 ? 'drop-before' : 'drop-after');
});
$('#list').addEventListener('drop', e => {
  e.preventDefault(); const r = e.target.closest('.row'); if (!dragName || !r || r.dataset.name === dragName) return;
  const b = r.getBoundingClientRect(), after = e.clientY >= b.top + b.height / 2, name = dragName;
  const o = G.S.order.filter(n => n !== name); o.splice(o.indexOf(r.dataset.name) + (after ? 1 : 0), 0, name);
  setOrder(o, `Moved ${pretty(name)}`);
});
$('#inspector').addEventListener('click', e => {
  const n = G.sel, t = e.target;
  if (t.closest('[data-act="status"]')) return cycleStatus(n);
  const fx = t.closest('[data-fixact]'); if (fx) return fixAction(fx.dataset.fixact);
  if (t.closest('[data-trace]')) return traceDialog('one');
  const mk = t.closest('[data-make]'); if (mk) return makeVersions([n], [mk.dataset.make]);
  const v = t.closest('[data-ver]'); if (v) return setVersion(v.dataset.ver);
  const j = t.closest('[data-jump]'); if (j) return jumpSong(n, +j.dataset.jump);
  const x = t.closest('[data-unmark]'); if (x) return removeMark(n, +x.dataset.unmark);
  const r = t.closest('[data-reveal]'); if (r) return reveal(r.dataset.reveal);
  if (t.id === 'mini') {
    const b = t.getBoundingClientRect(), f = (e.clientX - b.left) / b.width;
    if (n === E.cur) { E.seek(f * E.dur()); if (E.paused()) E.play(); } else { play(n); E.seek(f * track(n).dur); }
  }
});
$('#inspector').addEventListener('submit', e => {
  e.preventDefault(); const inp = $('#markInput');
  const at = inp.dataset.at != null ? +inp.dataset.at : G.sel === E.cur ? E.songTime() : 0;
  addMark(G.sel, at, inp.value); $('#markInput')?.focus();
});
$('#inspector').addEventListener('input', e => {
  if (e.target.id !== 'trackNotes') return;
  const v = e.target.value; if (v.trim()) G.S.notes[G.sel] = v; else delete G.S.notes[G.sel];
  save(); const row = $(`.row[data-name="${CSS.escape(G.sel)}"] .t`);
  const has = v.trim() || (G.S.marks[G.sel] || []).length, dot = row?.querySelector('.note-dot');
  if (has && row && !dot) row.insertAdjacentHTML('beforeend', '<span class="note-dot"></span>'); else if (!has && dot) dot.remove();
});
$('#inspector').addEventListener('dblclick', e => { if (e.target.closest('[data-rename]')) { setInspector(true); renameInspector(); } });
function renameInspector() {
  const h = $('#inspector h2'); if (!h) return;
  const n = G.sel, inp = document.createElement('input');
  inp.className = 'field rename big'; inp.value = pretty(n); inp.spellcheck = false; h.replaceWith(inp); inp.focus(); inp.select();
  let done = false;
  const finish = ok => { if (done) return; done = true; if (ok) setTitle(n, inp.value); else renderInspector(); };
  inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); });
  inp.addEventListener('blur', () => finish(true));
}
$('#inspector').addEventListener('keydown', e => {
  if (e.target.matches('[data-fix]')) { e.stopPropagation(); if (e.key === 'Enter') fixAction('save'); else if (e.key === 'Escape') fixAction('cancel'); return; }
  if (e.key === 'Escape' && e.target.closest('input,textarea')) e.target.blur();
});
$('#albumNotes').addEventListener('input', e => { G.S.albumNotes = e.target.value; save(); });

// player
$('#playBtn').onclick = togglePlay;
// back to the start of this song (or the one that just ended), or to the previous song in its first 3 s
$('#prevBtn').onclick = () => (seq.between() ? play(E.cur) : E.cur && E.bTime() > 3 ? E.seek(0) : step(-1));
$('#nextBtn').onclick = () => step(1);
$('#ab').addEventListener('click', e => { const b = e.target.closest('[data-side]'); if (b) setSide(b.dataset.side); });
$('#verSel').onchange = e => setVersion(e.target.value);
$('#match').onchange = e => { E.setMatch(e.target.checked); G.S.settings.match = e.target.checked; save(); };
$('#mode').addEventListener('click', e => { const b = e.target.closest('[data-mode]'); if (b) setMode(b.dataset.mode); });
function setMode(m) { E.setMode(m); G.S.settings.mode = m; save(); }
$('#vol').oninput = e => {
  E.setVolume(+e.target.value); PREFS.volume = E.volume; store.set('volume', E.volume);
  const v = $('#vol'), b = $('#volPct'); v.style.setProperty('--v', E.volume * 100 + '%');
  b.textContent = Math.round(E.volume * 100) + '%'; b.style.left = `calc(${E.volume * 100}% + ${(0.5 - E.volume) * 11}px)`; b.hidden = false;
  clearTimeout(b.t); b.t = setTimeout(() => (b.hidden = true), 900);
};
// waveform: click seeks, drag sets a loop, hover shows the time
const wave = $('#wavewrap');
let dragFrom = null;
const fracAt = e => { const r = wave.getBoundingClientRect(); return clamp((e.clientX - r.left) / r.width, 0, 1); };
wave.addEventListener('pointerdown', e => { if (!E.cur) return; dragFrom = fracAt(e); wave.setPointerCapture(e.pointerId); });
wave.addEventListener('pointermove', e => {
  if (!E.cur) return;
  hoverFrac = fracAt(e); const ht = $('#hoverTime');
  ht.hidden = false; ht.style.left = hoverFrac * 100 + '%'; ht.textContent = fmt(hoverFrac * E.dur());
  if (dragFrom != null && Math.abs(hoverFrac - dragFrom) > 0.004) { const sp = E.speed(), d = E.dur(); E.loop = { a: Math.min(dragFrom, hoverFrac) * d * sp, b: Math.max(dragFrom, hoverFrac) * d * sp, on: true }; }
  drawPlayer();
});
wave.addEventListener('pointerleave', () => { hoverFrac = -1; $('#hoverTime').hidden = true; drawPlayer(); });
wave.addEventListener('pointerup', e => {
  if (dragFrom == null) return;
  const f = fracAt(e), wasDrag = Math.abs(f - dragFrom) > 0.004; dragFrom = null;
  if (wasDrag) { E.seekSong(E.loop.a); if (E.paused()) E.play(); toast(`Looping ${fmt(E.loop.a)}–${fmt(E.loop.b)} · L to toggle, Esc to clear`); }
  else { E.seek(f * E.dur()); if (E.loop && (E.songTime() < E.loop.a || E.songTime() > E.loop.b)) E.loop.on = false; }
  drawAll();
});
$('#cont').onchange = e => { G.S.settings.cont = e.target.checked; save(); };
$('#gap').onchange = e => { G.S.settings.gap = +e.target.value; save(); renderHeader(); renderList(); renderInspector(); drawArcNow(); };
$('#tlen').onchange = e => { G.S.settings.tlen = +e.target.value; save(); };
$('#showTrans').onchange = e => setTransitions(e.target.checked);
$('#arc').addEventListener('click', e => {
  const r = e.target.getBoundingClientRect(), { st, total } = startTimes(), at = ((e.clientX - r.left) / r.width) * total;
  let n = G.S.order[0]; G.S.order.forEach(k => { if (st[k] <= at) n = k; });
  const off = clamp(at - st[n], 0, track(n).dur - 0.5);
  if (n === E.cur) { E.seekSong(off); if (E.paused()) E.play(); } else { play(n); E.seekSong(off); }
});
$('#exportBtn').onclick = () => exportDialog();
$('#undoBtn').onclick = undo; $('#copyBtn').onclick = copyTracklist; $('#padBtn').onclick = () => pad.toggle(); $('#resetBtn').onclick = resetOrder;
$('#themeBtn').onclick = toggleTheme; $('#inspBtn').onclick = () => setInspector(!PREFS.insp);

// ───────────────────────────────────────────── commands and keys
const app = {
  G, E, track, pretty, play, togglePlay, step, select, moveSel, move, undo, redo, resetOrder, cycleStatus, setStatus, setVersion, versionByIndex,
  setSide, setMode, startMark, openAlbum, copyTracklist, copyNotes, openFolder, reveal, toggleTheme, setInspector, setTransitions, previewTransition,
  toggleCont: () => { $('#cont').click(); toast(G.S.settings.cont ? 'Play through: on' : 'Play through: off'); },
  toggleMatch: () => { if (!showAB()) return toast('Pick a version to A/B against the album'); $('#match').click(); toast(E.match ? 'Loudness matched' : 'Loudness match off'); },
  clearLoop: () => { if (E.loop) { E.setLoop(null); drawAll(); toast('Loop cleared'); } },
  toggleLoop: () => { if (!E.loop) return toast('Drag across the waveform to set a loop, or use [ and ]'); E.toggleLoop(); drawAll(); toast(E.loop.on ? 'Loop on' : 'Loop off'); },
  loopPoint: which => { if (!E.cur) return; const t = E.songTime(), l = E.loop || { a: 0, b: track(E.cur).dur, on: true };
    if (which === 'a') l.a = t; else l.b = t; E.setLoop(l.a, l.b); drawAll(); toast(`Loop ${fmt(E.loop.a)}–${fmt(E.loop.b)}`); },
  insp: () => PREFS.insp,
  rename, setTitle, startJob, makeVersions, save, missingVersions, api, editAlbum, addAlbum, exportDialog, traceDialog, demo: DEMO,
  cur: () => E.cur, waitJob,
  togglePad: () => pad.toggle(), editAnalysis: () => { setInspector(true); fixAction('edit'); },
  downloadTracklist: () => downloadTracklist(app),
  makeAllMissing: () => {
    const miss = G.S.order.filter(n => missingVersions(track(n)).length);
    if (!miss.length) return toast('Every song already has every version');
    makeVersions(miss, []); },
};
const pad = createNotepad(app);
const cmd = initCommands(app);
// For checking the app from the browser console (or an AI agent's browser): godmix.state() is every state
// machine at once, as plain data; godmix.engine() is what the audio elements themselves are doing.
window.godmix = {
  state: () => ({
    mode: DEMO ? 'demo' : 'local', phase: G.phase, album: G.aid, selected: G.sel, editing,
    playing: E.cur ? { track: E.cur, version: E.ver?.label || '', side: E.side, paused: E.paused(), at: +E.songTime().toFixed(2), loop: E.loop && { ...E.loop } } : null,
    between: seq.state,
    jobs: JOBS.list.filter(isLive).map(j => ({ id: j.id, kind: j.kind, label: j.label, status: j.status, p: j.p })), serverLost: JOBS.offline,
  }),
  engine: () => E.debug(),
};
init().catch(err => { console.error(err); toast('GODMIX couldn’t start: ' + err.message, { ms: 8000 }); });
