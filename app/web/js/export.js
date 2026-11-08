// The export dialog: tagged song files and/or the whole album as one file (with a cue sheet), from the
// running order as it stands. Tags, titles and ISRCs are saved with the album's state; the cover is kept by
// the server (app/state/covers). The work itself is a server job (app/jobs.py export).
import { $, esc, fmtLong, ICON, toast } from './util.js';

// [key, name, what it's for] in groups. "As made" keeps the file's own sample rate and bit depth, sample for sample.
const FORMATS = [
  ['Uncompressed', [['wav', 'WAV', 'As made, bit-exact'], ['wav24_48', 'WAV 24-bit 48 kHz', 'Video, film, most distributors'],
    ['wav24_441', 'WAV 24-bit 44.1 kHz', 'Streaming distributors'], ['wav16', 'WAV 16-bit 44.1 kHz', 'CD, older distributors'], ['aiff', 'AIFF', 'As made: Logic, Apple, CD plants']]],
  ['Lossless, smaller', [['flac', 'FLAC', 'As made, about half the size'], ['alac', 'ALAC', 'As made, for Apple Music']]],
  ['Compressed', [['mp3', 'MP3 320 kbps', 'Sharing, DJs, anything'], ['aac', 'AAC 256 kbps', 'Apple devices, smaller']]],
];
const TAGS = [['artist', 'Artist'], ['album_artist', 'Album artist'], ['album', 'Album'], ['year', 'Year'], ['genre', 'Genre'], ['label', 'Label'],
  ['composer', 'Composer'], ['copyright', 'Copyright'], ['comment', 'Comment']];

export function defaultsFor(data) {
  const year = String(data.year || new Date().getFullYear());
  const artist = data.artist || '';
  return { artist, album_artist: artist, album: data.title, year,
    genre: '', label: '', composer: artist, copyright: artist ? `© ${year} ${artist}. All rights reserved.` : '', comment: '' };
}

export function downloadTracklist(app) {
  const { G } = app, d = G.data;
  const txt = `${d.title}${d.artist ? ' by ' + d.artist : ''}\n\n` + G.S.order.map((n, i) => `${i + 1}. ${app.pretty(n)}`).join('\n') + '\n';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([txt], { type: 'text/plain' }));
  a.download = `${d.title} - tracklist.txt`.replace(/[\\/:*?"<>|]/g, '');
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('Tracklist downloaded');
}

export function openExport(app, { what: preset } = {}) {
  const { G } = app, d = G.data, S = G.S;
  S.meta = { ...defaultsFor(d), ...(S.meta || {}) };
  S.isrc ||= {};
  const prefs = S.exportPrefs = { what: 'songs', version: '', formats: ['wav', 'mp3'], ...(S.exportPrefs || {}) };
  if (preset) prefs.what = preset;
  const kinds = d.version_kinds || [];
  let hasCover = false;

  const layer = document.createElement('div');
  layer.className = 'scrim';
  layer.innerHTML = `<div class="dialog export" role="dialog" aria-label="Export">
    <header><div><b>Export</b><span class="dim"> · ${esc(d.title)}${d.artist ? ' by ' + esc(d.artist) : ''}</span></div><button class="btn icon" data-x aria-label="Close">${ICON.close}</button></header>
    <div class="ex-body">
      <section class="ex-grid">
        <div><div class="label">What</div><div class="seg" id="exWhat">
          <button data-what="songs">Each song</button><button data-what="album" data-tip="One file, in your running order, with your gaps and a cue sheet">Full album</button><button data-what="both">Both</button></div></div>
        <div><div class="label">Version</div><select class="select" id="exVer"><option value="">Album version</option>${kinds.map(k => `<option>${esc(k)}</option>`).join('')}</select>
          <div class="ex-note" id="exVerNote"></div></div>
        <div class="span2"><div class="label">Formats <span class="dim">· tick as many as you like; each comes out tagged, with the cover</span></div>${FORMATS.map(([g, list]) =>
          `<div class="ex-group"><div class="ex-gname">${g}</div><div class="ex-formats">${list.map(([k, l, h]) =>
            `<label class="ex-check"><input type="checkbox" value="${k}"${prefs.formats.includes(k) ? ' checked' : ''}><span><b>${l}</b><small>${h}</small></span></label>`).join('')}</div></div>`).join('')}</div>
      </section>
      <section class="ex-meta">
        <div class="ex-cover" id="exCover" data-tip="Drop a PNG or JPEG, or click to choose"><img alt="" hidden><span>${ICON.album}<small>Cover</small></span><input type="file" accept="image/png,image/jpeg" hidden></div>
        <div class="ex-tags">${TAGS.map(([k, l]) => `<label class="${k === 'copyright' || k === 'comment' ? 'span2' : ''}"><span class="label">${l}</span><input class="field" data-meta="${k}" value="${esc(S.meta[k] || '')}" spellcheck="false"></label>`).join('')}</div>
      </section>
      <section><div class="label ex-tracks-hd"><span>Tracks · in your running order · titles here rename them in the app too</span><span id="exTotal"></span></div>
        <div class="ex-tracks">${S.order.map((n, i) => { const t = app.track(n); return `<div class="ex-row" data-name="${esc(n)}">
          <span class="mono dim">${String(i + 1).padStart(2, '0')}</span><input class="field" data-title value="${esc(app.pretty(n))}" spellcheck="false">
          <input class="field mono" data-isrc value="${esc(S.isrc[n] || t.isrc || '')}" placeholder="ISRC" spellcheck="false"><span class="mono dim ex-has" data-has></span></div>`; }).join('')}</div>
      </section>
    </div>
    <footer><span class="dim ex-where">Saved in <b>${esc(d.versions_folder ? d.versions_folder.replace(/[\\/]Versions$/, '') : d.folder)}</b> → Exports</span>
      <button class="btn" id="exList">${ICON.list}Tracklist .txt</button><button class="btn line" data-x>Cancel</button><button class="btn solid" id="exGo">Export <kbd>Ctrl ↵</kbd></button></footer>
  </div>`;
  document.body.append(layer);
  const dlg = $('.dialog', layer);
  const close = () => { layer.remove(); document.removeEventListener('keydown', onKey, true); };

  // ── what / version / formats ──
  const paint = () => {
    dlg.querySelectorAll('#exWhat button').forEach(b => b.classList.toggle('on', b.dataset.what === prefs.what));
    $('#exVer', dlg).value = prefs.version;
    const missing = S.order.filter(n => prefs.version && !(app.track(n).versions || []).some(v => v.label === prefs.version));
    $('#exVerNote', dlg).innerHTML = missing.length ? `${missing.length} song${missing.length > 1 ? 's don’t' : ' doesn’t'} have it yet and will use the album version. <button class="linkbtn" id="exMake">Make ${missing.length > 1 ? 'them' : 'it'} first</button>` : '';
    dlg.querySelectorAll('[data-has]').forEach(el => { el.textContent = prefs.version ? (missing.includes(el.closest('.ex-row').dataset.name) ? 'album' : '✓') : ''; });
    const secs = S.order.reduce((s, n) => s + (prefs.version && !missing.includes(n) ? app.track(n).versions.find(v => v.label === prefs.version).dur : app.track(n).dur), 0) + (S.order.length - 1) * +S.settings.gap;
    $('#exTotal', dlg).textContent = `${S.order.length} tracks · ${fmtLong(secs)}${prefs.what !== 'songs' ? ` with ${S.settings.gap} s gaps` : ''}`;
    const mk = $('#exMake', dlg);
    if (mk) mk.onclick = () => { app.makeVersions(missing, [prefs.version]); toast('Making them now. Export once they’re done (watch the sidebar).'); };
  };
  $('#exWhat', dlg).addEventListener('click', e => { const b = e.target.closest('[data-what]'); if (b) { prefs.what = b.dataset.what; paint(); app.save(); } });
  $('#exVer', dlg).onchange = e => { prefs.version = e.target.value; paint(); app.save(); };
  dlg.querySelectorAll('.ex-formats input').forEach(c => c.onchange = () => { prefs.formats = [...dlg.querySelectorAll('.ex-formats input:checked')].map(x => x.value); app.save(); });

  // ── tags, titles, ISRCs: saved as you type ──
  dlg.addEventListener('input', e => {
    const el = e.target;
    if (el.dataset.meta) { S.meta[el.dataset.meta] = el.value; app.save(); }
    else if ('title' in el.dataset) app.setTitle(el.closest('.ex-row').dataset.name, el.value, { quiet: true });
    else if ('isrc' in el.dataset) {
      const n = el.closest('.ex-row').dataset.name, v = el.value.trim().toUpperCase();
      if (!v || v === (app.track(n).isrc || '')) delete S.isrc[n]; else S.isrc[n] = v;
      el.classList.toggle('bad', !!v && !/^[A-Z]{2}-?[A-Z0-9]{3}-?\d{2}-?\d{5}$/.test(v));
      app.save();
    }
  });

  // ── cover ──
  const cov = $('#exCover', dlg), img = $('img', cov), file = $('input', cov);
  const showCover = () => { img.src = `/api/cover?album=${encodeURIComponent(G.aid)}&t=${Date.now()}`; };
  img.onload = () => { hasCover = true; img.hidden = false; cov.classList.add('has'); };
  img.onerror = () => { hasCover = false; img.hidden = true; cov.classList.remove('has'); };
  showCover();
  const upload = async f => {
    if (!f || !/image\/(png|jpeg)/.test(f.type)) return toast('Use a PNG or JPEG');
    const r = await fetch(`/api/cover?album=${encodeURIComponent(G.aid)}`, { method: 'POST', headers: { 'Content-Type': f.type, 'X-God-Mix': '1' }, body: f });
    if (r.ok) { showCover(); toast('Cover set'); } else toast('Couldn’t save the cover');
  };
  cov.onclick = () => file.click();
  file.onchange = () => upload(file.files[0]);
  cov.addEventListener('dragover', e => { e.preventDefault(); cov.classList.add('drop'); });
  cov.addEventListener('dragleave', () => cov.classList.remove('drop'));
  cov.addEventListener('drop', e => { e.preventDefault(); cov.classList.remove('drop'); upload(e.dataTransfer.files[0]); });
  cov.addEventListener('contextmenu', async e => {
    e.preventDefault(); if (!hasCover) return;
    await fetch(`/api/cover?album=${encodeURIComponent(G.aid)}&clear=1`, { method: 'POST', headers: { 'X-God-Mix': '1' } }); showCover(); toast('Cover removed');
  });

  // ── go ──
  const go = () => {
    if (!prefs.formats.length) return toast('Pick at least one format');
    const isrc = Object.fromEntries(S.order.map(n => [n, S.isrc[n] || app.track(n).isrc]).filter(([, v]) => v));
    app.startJob({ kind: 'export', album: G.aid, what: prefs.what, version: prefs.version, gap: +S.settings.gap, formats: prefs.formats,
      items: S.order.map(n => ({ id: n, title: app.pretty(n) })), meta: S.meta, isrc, cover: hasCover });
    close();
  };
  $('#exGo', dlg).onclick = go;
  $('#exList', dlg).onclick = () => downloadTracklist(app);
  layer.addEventListener('pointerdown', e => { if (e.target === layer) close(); });
  layer.addEventListener('click', e => { if (e.target.closest('[data-x]')) close(); });
  const onKey = e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); go(); }
    else e.stopPropagation();       // typing here never triggers the app's shortcuts
  };
  document.addEventListener('keydown', onKey, true);
  paint();
  $('input[data-meta="artist"]', dlg).focus();
}
