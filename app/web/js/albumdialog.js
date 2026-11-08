// Add an album from a folder of finished songs, or change an album's title, subtitle or artist.
// The work is a server job (app/jobs.py album): it writes local/albums.json and, for a new album, measures it.
import { $, esc, ICON, debounce } from './util.js';


export function openAlbumDialog(app, { mode = 'edit', album = null } = {}) {
  const add = mode === 'add', a = album || {};
  const layer = document.createElement('div');
  layer.className = 'scrim';
  layer.innerHTML = `<div class="dialog albumdlg" role="dialog" aria-label="${add ? 'Add an album' : 'Edit album'}">
    <header><b>${add ? 'Add an album' : `Edit ${esc(a.title)}`}</b><button class="btn icon" data-x aria-label="Close">${ICON.close}</button></header>
    <div class="ad-body">
      ${add ? `<label><span class="label">Folder</span><input class="field mono" id="adFolder" placeholder="C:\\Users\\you\\Music\\My Album" spellcheck="false">
        <small class="dim">Paste the full path of a folder of finished songs (WAV, FLAC or AIFF). Numbered files keep their order. GODMIX only reads them.</small></label>
        <div class="ad-files" id="adFiles"></div>` : ''}
      <div class="ad-row">
        <label><span class="label">Title</span><input class="field" id="adTitle" value="${esc(a.title || '')}" placeholder="000" spellcheck="false"></label>
        <label><span class="label">Artist</span><input class="field" id="adArtist" value="${esc(a.artist || '')}" placeholder="Optional: shown as “by …”" spellcheck="false"></label>
      </div>
      <label><span class="label">Subtitle <span class="dim">(optional)</span></span><input class="field" id="adSub" value="${esc(a.subtitle || '')}" placeholder="Leave empty to show just the title" spellcheck="false"></label>
      <p class="ad-preview dim" id="adPreview"></p>
    </div>
    <footer><span class="grow"></span><button class="btn line" data-x>Cancel</button><button class="btn solid" id="adGo">${add ? 'Add album' : 'Save'} <kbd>↵</kbd></button></footer>
  </div>`;
  document.body.append(layer);
  const dlg = $('.dialog', layer), close = () => { layer.remove(); document.removeEventListener('keydown', onKey, true); };
  const preview = () => {
    const t = $('#adTitle', dlg).value.trim() || (add ? 'Untitled' : a.title), s = $('#adSub', dlg).value.trim(), ar = $('#adArtist', dlg).value.trim();
    $('#adPreview', dlg).innerHTML = `Shows as <b>${esc(t)}</b>${s ? ` <span>${esc(s)}</span>` : ''} ${ar ? ` <span>by ${esc(ar)}</span>` : ''}`;
  };
  let files = 0;
  const look = debounce(async () => {
    const box = $('#adFiles', dlg), path = $('#adFolder', dlg).value.trim();
    if (!path) { box.innerHTML = ''; files = 0; return; }
    const r = await (await app.api.post('/api/folder', { path })).json();
    files = r.ok ? r.count : 0;
    box.innerHTML = r.ok ? (r.count ? `<div class="label">${r.count} song${r.count > 1 ? 's' : ''}</div>` + r.files.map((f, i) => `<div class="ad-file"><span class="mono dim">${String(i + 1).padStart(2, '0')}</span>${esc(f)}</div>`).join('')
      : '<div class="dim">No WAV, FLAC or AIFF files in that folder</div>') : `<div class="dim">${esc(r.error)}</div>`;
    if (r.ok && !$('#adTitle', dlg).value.trim()) { $('#adTitle', dlg).value = r.path.split(/[\\/]/).filter(Boolean).pop(); preview(); }
  }, 300);
  dlg.addEventListener('input', e => { if (e.target.id === 'adFolder') look(); preview(); });
  const go = () => {
    const body = { kind: 'album', action: mode, title: $('#adTitle', dlg).value.trim(), subtitle: $('#adSub', dlg).value.trim(), artist: $('#adArtist', dlg).value.trim() };
    if (add) { body.folder = $('#adFolder', dlg).value.trim().replace(/^"|"$/g, ''); if (!files) return $('#adFolder', dlg).focus(); }
    else { body.id = a.id; if (!body.title) return $('#adTitle', dlg).focus(); }
    app.startJob(body); close();
  };
  $('#adGo', dlg).onclick = go;
  layer.addEventListener('pointerdown', e => { if (e.target === layer) close(); });
  layer.addEventListener('click', e => { if (e.target.closest('[data-x]')) close(); });
  const onKey = e => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Enter') { e.preventDefault(); go(); }
    e.stopPropagation();
  };
  document.addEventListener('keydown', onKey, true);
  preview();
  (add ? $('#adFolder', dlg) : $('#adTitle', dlg)).focus();
}
