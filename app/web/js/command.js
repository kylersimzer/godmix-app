// The command menu (Ctrl/⌘ K), the keyboard shortcut sheet (?), the row menu and every keyboard shortcut.
import { $, esc, fmt, pad2, ICON, STATUS, STATUS_ORDER, MOD, isMac } from './util.js';
import { MODES } from './engine.js';

// [group, keys, label] — the shortcut sheet is drawn from this list, so it can't drift from the code.
export const SHORTCUTS = [
  ['Playback', ['Space'], 'Play or pause'],
  ['Playback', ['←', '→'], 'Back or forward 5 s'],
  ['Playback', ['Shift', '← →'], 'Previous or next track'],
  ['Playback', ['Enter'], 'Play the selected track'],
  ['Playback', ['C'], 'Play through the album'],
  ['Compare', ['A'], 'Hear A (original or album)'],
  ['Compare', ['B'], 'Hear B (master or version)'],
  ['Compare', ['Tab'], 'Flip A and B'],
  ['Compare', ['0–9'], 'Album version, then each version'],
  ['Compare', ['V'], 'Next version'],
  ['Compare', ['M'], 'Stereo → mono → phone'],
  ['Compare', ['G'], 'Match loudness'],
  ['Loop', ['drag'], 'Drag across the waveform to loop'],
  ['Loop', ['[', ']'], 'Set loop start or end here'],
  ['Loop', ['L'], 'Loop on or off'],
  ['Loop', ['Esc'], 'Clear the loop'],
  ['Running order', ['↑', '↓'], 'Select previous or next'],
  ['Running order', ['Alt', '↑ ↓'], 'Move the selected track'],
  ['Running order', [MOD, 'Z'], 'Undo a move'],
  ['Running order', [MOD, 'Shift', 'Z'], 'Redo'],
  ['Running order', ['S'], 'Cycle status: needs work, approved'],
  ['Running order', ['N'], 'Mark this moment with a note'],
  ['Running order', ['T'], 'Show transitions'],
  ['Running order', ['F2'], 'Rename the selected song'],
  ['App', ['E'], 'Export songs or the full album'],
  ['App', ['R'], 'Trace Tags: a traceable copy for each person'],
  ['App', ['P'], 'Notes: the album’s notepad'],
  ['App', [MOD, 'K'], 'Search and commands'],
  ['App', ['I'], 'Track details panel'],
  ['App', ['Shift', 'T'], 'Light or dark'],
  ['App', ['?'], 'This sheet'],
];

export function initCommands(app) {
  const { G, E } = app;
  let layer = null;
  const close = () => { layer?.remove(); layer = null; };
  const isOpen = () => !!layer;

  // ── the command menu ──
  function commands() {
    const list = [], cur = E.cur && app.track(E.cur), sel = G.sel && app.track(G.sel);
    G.S?.order.forEach((n, i) => list.push({ group: 'Tracks', icon: ICON.play, label: app.pretty(n), hint: pad2(i + 1), keywords: `${app.track(n).camelot} ${Math.round(app.track(n).bpm)}`, run: () => app.play(n) }));
    G.albums.forEach(a => list.push({ group: 'Albums', icon: ICON.album, label: `${a.title}${a.subtitle ? ' · ' + a.subtitle : ''}`, hint: `${a.tracks} tracks`, run: () => app.openAlbum(a.id) }));
    const t = sel || cur;
    if (t) [{ label: G.data.released ? 'Album version' : 'Album master' }, ...(t.versions || [])].forEach((v, k) =>
      list.push({ group: `Versions · ${app.pretty(G.sel || E.cur)}`, icon: ICON.waves, label: v.label, hint: String(k), run: () => app.versionByIndex(k) }));
    const A = (label, run, hint = '', icon = ICON.dial) => list.push({ group: 'Actions', icon, label, hint, run });
    A('Play or pause', app.togglePlay, 'Space', ICON.play);
    A(`Play through the album: ${G.S?.settings.cont ? 'turn off' : 'turn on'}`, app.toggleCont, 'C');
    A('Listen in stereo', () => app.setMode('stereo'), 'M', ICON.waves); A('Listen in mono', () => app.setMode('mono'), 'M', ICON.waves); A('Listen on a phone speaker', () => app.setMode('phone'), 'M', ICON.waves);
    A('Match loudness on or off', app.toggleMatch, 'G');
    A('Loop on or off', app.toggleLoop, 'L', ICON.loop); A('Clear the loop', app.clearLoop, 'Esc', ICON.loop);
    if (sel) {
      STATUS_ORDER.forEach(s => A(`Mark “${app.pretty(G.sel)}” as ${STATUS[s].label.toLowerCase()}`, () => app.setStatus(G.sel, s), 'S', STATUS[s].icon));
      A(`Hear the transition after “${app.pretty(G.sel)}”`, () => { const i = G.S.order.indexOf(G.sel); if (i < G.S.order.length - 1) app.previewTransition(i); }, '', ICON.play);
      if (!app.demo) A(`Show “${app.pretty(G.sel)}” in the file manager`, () => app.reveal('master'), '', ICON.file);
    }
    A('Add a mark at the playhead', app.startMark, 'N', ICON.note);
    A('Export songs (tagged files)…', () => app.exportDialog('songs'), 'E', ICON.ext);
    A('Render the full album as one file…', () => app.exportDialog('album'), '', ICON.ext);
    A('Trace Tags: a tagged copy of this song for each person…', () => app.traceDialog('one'), 'R', ICON.trace);
    A('Trace Tags for the whole album…', () => app.traceDialog('all'), '', ICON.trace);
    A('Check a leak: whose copy is it?', () => app.traceDialog(), '', ICON.trace);
    A('Download the tracklist (.txt)', app.downloadTracklist, '', ICON.list);
    A('Open the notepad', app.togglePad, 'P', ICON.pad);
    A('Add an album from a folder…', app.addAlbum, '', ICON.plus);
    A(`Edit this album’s title or artist…`, () => app.editAlbum(), '', ICON.edit);
    A('Make every missing version for this album', app.makeAllMissing, '', ICON.waves);
    if (sel) {
      A(`Rename “${app.pretty(G.sel)}”`, () => app.rename(G.sel), 'F2', ICON.note);
      A(`Correct the analysis of “${app.pretty(G.sel)}” (tempo, key, levels)`, app.editAnalysis, '', ICON.edit);
      app.missingVersions(sel).forEach(l => A(`Make ${l} for “${app.pretty(G.sel)}”`, () => app.makeVersions([G.sel], [l]), '', ICON.waves));
    }
    A('Copy the tracklist', app.copyTracklist, '', ICON.copy); A('Copy notes and marks as Markdown', app.copyNotes, '', ICON.note);
    A('Undo', app.undo, `${MOD} Z`, ICON.undo); A('Redo', app.redo, `${MOD} ⇧ Z`, ICON.redo); A('Reset to the album’s order', app.resetOrder, '', ICON.reset);
    A('Toggle the details panel', () => app.setInspector(!app.insp()), 'I', ICON.panel); A('Toggle transitions in the list', () => app.setTransitions(!$('#showTrans').checked), 'T', ICON.list);
    A('Switch light or dark', app.toggleTheme, '⇧ T', ICON.sun); A('Keyboard shortcuts', help, '?', ICON.keyboard);
    A('Open the GODMIX homepage', () => (location.href = '/'), '', ICON.home);
    if (G.data && !app.demo) {
      const F = (label, folder, sub = '') => list.push({ group: 'Folders', icon: ICON.folder, label, run: () => app.openFolder({ folder, sub }) });
      F(G.data.released ? 'Open the album files' : 'Open the originals', 'orig');
      if (!G.data.released) { F('Open the 24-bit masters', 'master', '24'); F('Open the 16-bit masters', 'master', '16'); }
      F('Open the versions folder', 'versions');
    }
    return list;
  }
  // fuzzy match: every query character in order; earlier, word-start and consecutive hits score higher
  function score(q, text) {
    if (!q) return 1;
    const s = text.toLowerCase(); let i = 0, sc = 0, last = -2;
    for (const ch of q) {
      const j = s.indexOf(ch, i); if (j < 0) return 0;
      sc += (j === last + 1 ? 3 : 1) + (j === 0 || s[j - 1] === ' ' ? 2 : 0) - j * 0.01; last = j; i = j + 1;
    }
    return sc + (s.startsWith(q) ? 5 : 0);
  }
  const hl = (label, q) => { if (!q) return esc(label); let i = 0, out = ''; const s = label.toLowerCase();
    for (let k = 0; k < label.length; k++) { if (i < q.length && s[k] === q[i]) { out += `<em>${esc(label[k])}</em>`; i++; } else out += esc(label[k]); } return out; };

  function open(initial = '') {
    close();
    layer = document.createElement('div');
    layer.className = 'scrim';
    layer.innerHTML = `<div class="dialog cmd" role="dialog" aria-label="Command menu"><input placeholder="Search tracks, versions, albums and commands…" aria-label="Search" spellcheck="false"><div class="results" role="listbox"></div>
      <div class="foot"><span><kbd>↑</kbd> <kbd>↓</kbd> move</span><span><kbd>Enter</kbd> run</span><span><kbd>Esc</kbd> close</span></div></div>`;
    document.body.append(layer);
    const inp = $('input', layer), res = $('.results', layer), all = commands();
    let shown = [], at = 0;
    const draw = () => {
      const q = inp.value.trim().toLowerCase();
      shown = all.map(c => ({ c, s: Math.max(score(q, c.label), score(q, `${c.group} ${c.label} ${c.keywords || ''}`) * 0.8) })).filter(x => x.s > 0);
      if (q) shown.sort((a, b) => b.s - a.s); else shown = shown.filter(x => x.c.group !== 'Tracks' || x.c.label);
      shown = shown.slice(0, q ? 40 : 60).map(x => x.c);
      at = Math.min(at, Math.max(0, shown.length - 1));
      let g = null;
      res.innerHTML = shown.length ? shown.map((c, i) => (c.group !== g ? `<div class="group label">${esc((g = c.group))}</div>` : '') +
        `<div class="item${i === at ? ' on' : ''}" data-i="${i}" role="option">${c.icon}<span class="txt">${hl(c.label, q)}</span><span class="hint">${esc(c.hint || '')}</span></div>`).join('')
        : `<div class="none">Nothing matches “${esc(inp.value)}”</div>`;
      res.querySelector('.item.on')?.scrollIntoView({ block: 'nearest' });
    };
    const run = i => { const c = shown[i]; if (!c) return; close(); c.run(); };
    inp.addEventListener('input', () => { at = 0; draw(); });
    inp.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { e.preventDefault(); at = Math.min(shown.length - 1, at + 1); draw(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); at = Math.max(0, at - 1); draw(); }
      else if (e.key === 'Enter') { e.preventDefault(); run(at); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
      e.stopPropagation();
    });
    res.addEventListener('pointermove', e => { const it = e.target.closest('.item'); if (it && +it.dataset.i !== at) { at = +it.dataset.i; res.querySelectorAll('.item').forEach(x => x.classList.toggle('on', +x.dataset.i === at)); } });
    res.addEventListener('click', e => { const it = e.target.closest('.item'); if (it) run(+it.dataset.i); });
    layer.addEventListener('pointerdown', e => { if (e.target === layer) close(); });
    inp.value = initial; draw(); inp.focus();
  }

  // ── shortcut sheet ──
  function help() {
    close();
    layer = document.createElement('div');
    layer.className = 'scrim';
    let g = null;
    layer.innerHTML = `<div class="dialog help" role="dialog" aria-label="Keyboard shortcuts"><header><b>Keyboard shortcuts</b><button class="btn icon" aria-label="Close">${ICON.close}</button></header><div class="cols">` +
      SHORTCUTS.map(([grp, keys, label]) => (grp !== g ? `<h4 class="label">${esc((g = grp))}</h4>` : '') +
        `<div class="k"><span>${esc(label)}</span><span>${keys.map(k => `<kbd>${esc(k)}</kbd>`).join('')}</span></div>`).join('') + '</div></div>';
    document.body.append(layer);
    layer.addEventListener('pointerdown', e => { if (e.target === layer || e.target.closest('header .btn')) close(); });
  }

  // ── a small menu at a point: items are [label, run, key, icon] or null for a divider ──
  function menu(items, x, y) {
    close();
    layer = document.createElement('div');
    layer.style.cssText = 'position:fixed;inset:0;z-index:59';
    layer.innerHTML = `<div class="menu" role="menu">${items.map((it, k) => it ? `<button data-k="${k}" role="menuitem">${it[3] || ''}<span>${esc(it[0])}</span>${it[2] ? `<kbd>${esc(it[2])}</kbd>` : ''}</button>` : '<hr>').join('')}</div>`;
    document.body.append(layer);
    const m = $('.menu', layer), r = m.getBoundingClientRect();
    m.style.left = Math.min(x, innerWidth - r.width - 8) + 'px'; m.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
    m.querySelectorAll('svg').forEach(s => { s.style.width = '14px'; s.style.height = '14px'; s.style.color = 'var(--fg-3)'; });
    layer.addEventListener('pointerdown', e => { const b = e.target.closest('button[data-k]'); if (!b) close(); });
    m.addEventListener('click', e => { const b = e.target.closest('button[data-k]'); if (b) { close(); items[+b.dataset.k][1](); } });
  }

  // ── row menu (right-click, or the ⋯ button) ──
  function rowMenu(n, x, y) {
    close();
    const i = G.S.order.indexOf(n), last = G.S.order.length - 1, t = app.track(n);
    const items = [
      ['Play', () => app.play(n), 'Enter', ICON.play],
      ...(i < last ? [['Hear the transition into the next song', () => app.previewTransition(i), '', ICON.play]] : []),
      null,
      ['Move up', () => app.move(n, i - 1), 'Alt ↑', ICON.up], ['Move down', () => app.move(n, i + 1), 'Alt ↓', ICON.down],
      ['Move to the top', () => app.move(n, 0), '', ICON.up], ['Move to the end', () => app.move(n, last), '', ICON.down],
      null,
      ...STATUS_ORDER.map(s => [STATUS[s].label, () => app.setStatus(n, s), '', STATUS[s].icon]),
      null,
      ['Rename…', () => app.rename(n), 'F2', ICON.note],
      ...(app.missingVersions(t).length ? [['Make the missing versions', () => app.makeVersions([n], app.missingVersions(t)), '', ICON.waves]] : []),
      ...(app.demo ? [] : [['Show the file', () => { app.select(n); app.reveal('master'); }, '', ICON.file]]),
      ['Copy the title', () => navigator.clipboard?.writeText(app.pretty(n)), '', ICON.copy],
    ];
    menu(items, x, y);
  }

  // ── keyboard ──
  document.addEventListener('keydown', e => {
    const mod = isMac ? e.metaKey : e.ctrlKey, k = e.key;
    if (mod && k.toLowerCase() === 'k') { e.preventDefault(); return isOpen() ? close() : open(); }
    if (isOpen()) { if (k === 'Escape') { e.preventDefault(); close(); } return; }
    const tag = e.target.tagName, typing = tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && !['checkbox', 'range'].includes(e.target.type));
    if (typing || !G.data) return;
    if (mod && k.toLowerCase() === 'z') { e.preventDefault(); return e.shiftKey ? app.redo() : app.undo(); }
    if (mod && k.toLowerCase() === 'y') { e.preventDefault(); return app.redo(); }
    if (mod || e.altKey && !['ArrowUp', 'ArrowDown'].includes(k)) return;
    const done = () => e.preventDefault();
    if (k === ' ') { done(); app.togglePlay(); }
    else if (e.altKey && k === 'ArrowUp' && G.sel) { done(); app.move(G.sel, G.S.order.indexOf(G.sel) - 1); }
    else if (e.altKey && k === 'ArrowDown' && G.sel) { done(); app.move(G.sel, G.S.order.indexOf(G.sel) + 1); }
    else if (k === 'ArrowUp' || k === 'k') { done(); app.moveSel(-1); }
    else if (k === 'ArrowDown' || k === 'j') { done(); app.moveSel(1); }
    else if (e.shiftKey && k === 'ArrowRight') { done(); app.step(1); }
    else if (e.shiftKey && k === 'ArrowLeft') { done(); app.step(-1); }
    else if (k === 'ArrowRight' && E.cur) { done(); E.nudge(5); }
    else if (k === 'ArrowLeft' && E.cur) { done(); E.nudge(-5); }
    else if (k === 'Enter' && G.sel && !e.target.closest?.('button,a')) { done(); app.play(G.sel); }
    else if (k === 'a' || k === 'A') app.setSide('A');
    else if (k === 'b' || k === 'B') app.setSide('B');
    else if (k === 'Tab' && E.cur) { done(); app.setSide(E.side === 'A' ? 'B' : 'A'); }
    else if (/^[0-9]$/.test(k)) app.versionByIndex(+k);
    else if (k === 'v' || k === 'V') { const t = app.track(G.sel || E.cur), vs = t?.versions || [], cur = E.cur === (G.sel || E.cur) && E.ver ? vs.indexOf(E.ver) + 1 : 0; app.versionByIndex((cur + 1) % (vs.length + 1)); }
    else if (k === 'm' || k === 'M') app.setMode(MODES[(MODES.indexOf(E.mode) + 1) % MODES.length]);
    else if (k === 'g' || k === 'G') app.toggleMatch();
    else if (k === 'c' || k === 'C') app.toggleCont();
    else if (k === 'l' || k === 'L') app.toggleLoop();
    else if (k === '[') app.loopPoint('a');
    else if (k === ']') app.loopPoint('b');
    else if (k === 'Escape') app.clearLoop();
    else if (k === 's' || k === 'S') { if (G.sel) app.cycleStatus(G.sel); }
    else if (k === 'n' || k === 'N') { done(); app.startMark(); }
    else if (k === 'T' && e.shiftKey) app.toggleTheme();
    else if (k === 'F2') { done(); app.rename(G.sel); }
    else if (k === 'e' || k === 'E') { done(); app.exportDialog(); }
    else if (k === 'r' || k === 'R') { done(); app.traceDialog(); }
    else if (k === 'p' || k === 'P') { done(); app.togglePad(); }
    else if (k === 't') app.setTransitions(!$('#showTrans').checked);
    else if (k === 'i' || k === 'I') app.setInspector(!app.insp());
    else if (k === '?' || (k === '/' && e.shiftKey)) help();
    else if (k === '/') { done(); open(); }
  });
  $('#openCmd').addEventListener('click', () => open());
  $('#helpBtn').addEventListener('click', help);
  return { open, help, rowMenu, menu, close };
}
