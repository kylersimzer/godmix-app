// Trace Tags: a tagged copy of a song (or the album) for each person you send it to. Each copy's tags land at
// times only that copy has, so if one leaks, "Check a leak" says whose it was. The work is a server job
// (app/jobs.py trace, trace_tags.py); the ledger of copies is app/state/trace-tags.json.
import { $, esc, ICON, toast } from './util.js';

const DENSITY = [['light', 'Light', 'About every 20 s'], ['normal', 'Normal', 'Every 8 to 15 s'], ['heavy', 'Heavy', 'Every 5 to 9 s']];
const cleanName = s => s.replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 60);
const clipName = s => s.replace(/[^\w .()&'-]/g, '').replace(/\s+/g, ' ').trim().slice(-80);

export function openTraceTags(app, { scope } = {}) {
  const { G, api } = app, d = G.data, S = G.S;
  const prefs = S.tracePrefs = {
    what: 'one', version: '', phrase: d.artist ? `${d.artist}. Demo.` : 'Demo. Not for release.', voice: 'male', say_name: true,
    clips: [], people: [], density: 'normal', formats: ['mp3'], ...(S.tracePrefs || {}) };
  if (scope) prefs.what = scope;
  let n = G.sel || app.cur() || S.order[0];            // the song for "one song"; the picker in Songs changes it
  const kinds = d.version_kinds || [];
  let info = { clips: [], recent: [], total: 0 }, audio = null;

  const layer = document.createElement('div');
  layer.className = 'scrim';
  layer.innerHTML = `<div class="dialog export trace" role="dialog" aria-label="Trace Tags">
    <header><div><b>Trace Tags</b><span class="dim"> · a tagged copy for each person, traceable if it leaks</span></div><button class="btn icon" data-x aria-label="Close">${ICON.close}</button></header>
    <div class="ex-body">
      <section class="ex-grid">
        <div><div class="label">Songs</div><div class="tt-songs"><div class="seg" id="ttWhat"><button data-what="one" id="ttSong" aria-haspopup="listbox" data-tip="Pick a different song"><span></span><svg class="tt-chev" viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></button><button data-what="all">Whole album · ${S.order.length}</button></div><div class="tt-pick" id="ttPick" role="listbox" hidden></div></div></div>
        <div><div class="label">Version</div><select class="select" id="ttVer"><option value="">Album version</option>${kinds.map(k => `<option>${esc(k)}</option>`).join('')}</select>
          <div class="ex-note" id="ttVerNote"></div></div>
      </section>
      <section>
        <div class="label">The tag <span class="dim">· what the voice says</span></div>
        <div class="tt-say">
          <input class="field" id="ttPhrase" value="${esc(prefs.phrase)}" placeholder="Words to say, like: Demo. Not for release." spellcheck="false" maxlength="200">
          <div class="seg" id="ttVoice"><button data-voice="male">Male</button><button data-voice="female">Female</button></div>
          <button class="btn line" id="ttHear">${ICON.play}Hear it</button>
        </div>
        <div class="tt-clips" id="ttClips"></div>
        <label class="tt-opt"><input type="checkbox" id="ttName"${prefs.say_name ? ' checked' : ''}><span><b>Say each person’s name too</b><small>“For Jordan” in about a third of the tags, so they hear it’s their copy</small></span></label>
      </section>
      <section>
        <div class="label">Who it’s for <span class="dim">· one copy each</span></div>
        <div class="tt-people" id="ttPeople"><input id="ttAdd" placeholder="Type a name, press Enter" spellcheck="false" maxlength="60"></div>
      </section>
      <section class="ex-grid">
        <div><div class="label">How often</div><div class="seg" id="ttDensity">${DENSITY.map(([k, l]) => `<button data-density="${k}">${l}</button>`).join('')}</div><div class="ex-note" id="ttDensityNote"></div></div>
        <div><div class="label">Format</div><div class="tt-fmts">${[['mp3', 'MP3 320', 'For sending'], ['wav', 'WAV', 'Full quality']].map(([k, l, h]) =>
          `<label class="ex-check"><input type="checkbox" value="${k}"${prefs.formats.includes(k) ? ' checked' : ''}><span><b>${l}</b><small>${h}</small></span></label>`).join('')}</div></div>
      </section>
      <section>
        <div class="label ex-tracks-hd"><span>Check a leak</span><span id="ttTotal"></span></div>
        <div class="tt-check" id="ttCheck" tabindex="0"><span>${ICON.search}<b>Drop a leaked file here</b><small>or click to choose one. GODMIX listens for the tags and tells you whose copy it is.</small></span><input type="file" accept="audio/*,.wav,.flac,.aif,.aiff,.mp3,.m4a" hidden></div>
        <div class="tt-result" id="ttResult" hidden></div>
        <div class="tt-recent" id="ttRecent"></div>
      </section>
    </div>
    <footer><span class="dim ex-where">Saved in <b>${esc(d.versions_folder ? d.versions_folder.replace(/[\\/]Versions$/, '') : d.folder)}</b> → Exports → Trace Tags, a folder per person</span>
      <button class="btn line" data-x>Cancel</button><button class="btn solid" id="ttGo">Make copies <kbd>Ctrl ↵</kbd></button></footer>
  </div>`;
  document.body.append(layer);
  const dlg = $('.dialog', layer);
  const close = () => { audio?.pause(); layer.remove(); document.removeEventListener('keydown', onKey, true); };
  const songs = () => (prefs.what === 'all' ? S.order : [n]);

  // ── paint everything that depends on the choices ──
  const paint = () => {
    dlg.querySelectorAll('#ttWhat button').forEach(b => b.classList.toggle('on', b.dataset.what === prefs.what));
    $('#ttSong span', dlg).textContent = app.pretty(n);
    dlg.querySelectorAll('#ttVoice button').forEach(b => b.classList.toggle('on', b.dataset.voice === prefs.voice));
    dlg.querySelectorAll('#ttDensity button').forEach(b => b.classList.toggle('on', b.dataset.density === prefs.density));
    $('#ttDensityNote', dlg).textContent = DENSITY.find(x => x[0] === prefs.density)[2];
    $('#ttVer', dlg).value = prefs.version;
    const missing = songs().filter(s => prefs.version && !(app.track(s).versions || []).some(v => v.label === prefs.version));
    $('#ttVerNote', dlg).textContent = missing.length ? `${missing.length === 1 && songs().length === 1 ? 'This song doesn’t' : `${missing.length} song${missing.length > 1 ? 's don’t' : ' doesn’t'}`} have it yet, so ${missing.length > 1 ? 'they' : 'it'}’ll use the album version` : '';
    const ppl = $('#ttPeople', dlg), add = $('#ttAdd', dlg);
    ppl.querySelectorAll('.tt-person').forEach(x => x.remove());
    prefs.people.forEach(p => add.insertAdjacentHTML('beforebegin', `<span class="tt-person">${esc(p)}<button data-unperson="${esc(p)}" aria-label="Remove ${esc(p)}">${ICON.close}</button></span>`));
    $('#ttClips', dlg).innerHTML = info.clips.map(c => `<div class="tt-clip${prefs.clips.includes(c) ? ' on' : ''}" data-clip="${esc(c)}">
        <label><input type="checkbox"${prefs.clips.includes(c) ? ' checked' : ''}><span>${esc(c.replace(/\.[^.]+$/, ''))}</span></label>
        <button class="btn icon" data-play="${esc(c)}" aria-label="Play">${ICON.play}</button><button class="btn icon" data-unclip="${esc(c)}" aria-label="Remove">${ICON.close}</button></div>`).join('')
      + `<label class="tt-addclip btn line">${ICON.plus}Add a recording<input type="file" accept="audio/*,.wav,.flac,.aif,.aiff,.mp3" hidden></label>
         <span class="dim tt-cliphint">${info.clips.length ? 'Ticked recordings rotate with the words' : 'Your own voice tag, any WAV, FLAC, AIFF or MP3. Several make it harder to strip.'}</span>`;
    const copies = songs().length * prefs.people.length;
    $('#ttGo', dlg).innerHTML = `${copies ? `Make ${copies} cop${copies === 1 ? 'y' : 'ies'}` : 'Make copies'} <kbd>Ctrl ↵</kbd>`;
    $('#ttGo', dlg).disabled = !copies;
    $('#ttTotal', dlg).textContent = info.total ? `${info.total} cop${info.total === 1 ? 'y' : 'ies'} on record` : '';
    $('#ttRecent', dlg).innerHTML = info.recent.length ? `<div class="tt-recent-hd dim">Latest copies</div>` + info.recent.slice(0, 6).map(c =>
      `<div class="tt-row"><b>${esc(c.recipient)}</b><span>${esc(c.title)}${c.version ? ` <span class="dim">· ${esc(c.version)}</span>` : ''}</span><span class="mono dim">${esc(c.made.slice(0, 10))}</span></div>`).join('') : '';
  };
  const load = async () => { try { info = await api.json('/api/trace'); prefs.clips = prefs.clips.filter(c => info.clips.includes(c)); } catch {} paint(); };

  // ── choices ──
  dlg.addEventListener('click', e => {
    const t = e.target, b = t.closest('button');
    if (!t.closest('#ttPick, #ttSong')) closePick();
    if (b?.dataset.pick) { n = b.dataset.pick; prefs.what = 'one'; closePick(); }
    else if (b?.dataset.what === 'one') { prefs.what = 'one'; pick.hidden ? openPick() : closePick(); }
    else if (b?.dataset.what) { prefs.what = b.dataset.what; }
    else if (b?.dataset.voice) { prefs.voice = b.dataset.voice; }
    else if (b?.dataset.density) { prefs.density = b.dataset.density; }
    else if (b?.dataset.unperson) { prefs.people = prefs.people.filter(p => p !== b.dataset.unperson); }
    else if (b?.dataset.play) { play(`/api/trace/clip?name=${encodeURIComponent(b.dataset.play)}`); return; }
    else if (b?.dataset.unclip) { removeClip(b.dataset.unclip); return; }
    else if (t.closest('#ttPeople') && !b) { $('#ttAdd', dlg).focus(); return; }
    else return;
    paint(); app.save();
  });
  $('#ttVer', dlg).onchange = e => { prefs.version = e.target.value; paint(); app.save(); };
  $('#ttPhrase', dlg).oninput = e => { prefs.phrase = e.target.value; app.save(); };
  $('#ttName', dlg).onchange = e => { prefs.say_name = e.target.checked; app.save(); };
  dlg.querySelectorAll('.tt-fmts input').forEach(c => c.onchange = () => { prefs.formats = [...dlg.querySelectorAll('.tt-fmts input:checked')].map(x => x.value); app.save(); });
  $('#ttClips', dlg).addEventListener('change', e => {
    const row = e.target.closest('[data-clip]');
    if (row) { const c = row.dataset.clip; prefs.clips = e.target.checked ? [...prefs.clips, c] : prefs.clips.filter(x => x !== c); paint(); app.save(); }
    else if (e.target.type === 'file') addClip(e.target.files[0]);
  });

  // ── the song picker: click the song's name in Songs ──
  const pick = $('#ttPick', dlg);
  function openPick() {
    pick.innerHTML = S.order.map((s, i) => `<button role="option" data-pick="${esc(s)}" class="${s === n ? 'on cur' : ''}" aria-selected="${s === n}">
      <span class="mono dim">${String(i + 1).padStart(2, '0')}</span><span>${esc(app.pretty(s))}</span>${s === n ? ICON.check : ''}</button>`).join('');
    pick.hidden = false;
    $('#ttSong', dlg).setAttribute('aria-expanded', 'true');
    pick.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  }
  function closePick() { pick.hidden = true; $('#ttSong', dlg)?.setAttribute('aria-expanded', 'false'); }
  const pickKey = e => {             // ↑ ↓ to move, Enter to choose, Esc to close
    const items = [...pick.querySelectorAll('button')], i = items.findIndex(x => x.classList.contains('on'));
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const k = Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
      items.forEach((x, j) => x.classList.toggle('on', j === k)); items[k].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && i >= 0) { e.preventDefault(); items[i].click(); }
    else if (e.key === 'Escape') { e.preventDefault(); closePick(); $('#ttSong', dlg).focus(); }
    else return false;
    return true;
  };

  // ── people: type a name and press Enter (or a comma); pasting a list adds them all ──
  const add = $('#ttAdd', dlg);
  const addPeople = text => {
    const names = text.split(/[,\n;]/).map(cleanName).filter(Boolean);
    for (const p of names) if (!prefs.people.some(x => x.toLowerCase() === p.toLowerCase())) prefs.people.push(p);
    add.value = ''; paint(); app.save();
  };
  // (called from onKey below: the dialog catches keys before they reach the field)
  const peopleKey = e => {
    if ((e.key === 'Enter' && !e.ctrlKey && !e.metaKey) || e.key === ',') { e.preventDefault(); if (add.value.trim()) addPeople(add.value); }
    else if (e.key === 'Backspace' && !add.value && prefs.people.length) { prefs.people.pop(); paint(); app.save(); }
  };
  add.addEventListener('paste', e => { const t = e.clipboardData.getData('text'); if (/[,\n;]/.test(t)) { e.preventDefault(); addPeople(t); } });
  add.addEventListener('blur', () => { if (add.value.trim()) addPeople(add.value); });

  // ── hearing the tag ──
  const play = url => { audio?.pause(); audio = new Audio(url); audio.volume = 0.6; audio.play().catch(() => toast('Couldn’t play that')); };
  $('#ttHear', dlg).onclick = async () => {
    const text = $('#ttPhrase', dlg).value.trim() || 'Demo';
    const btn = $('#ttHear', dlg); btn.disabled = true;
    try {
      const r = await api.post('/api/trace/preview', { text, voice: prefs.voice });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
      play(URL.createObjectURL(await r.blob()));
    } catch (err) { toast(`Couldn’t make the voice: ${err.message}`, { ms: 6000 }); }
    btn.disabled = false;
  };
  async function addClip(f) {
    if (!f) return;
    const name = clipName(f.name);
    if (!/\.(wav|flac|aiff?|mp3)$/i.test(name)) return toast('Use a WAV, FLAC, AIFF or MP3');
    const r = await fetch(`/api/trace/clip?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'X-God-Mix': '1' }, body: f });
    if (!r.ok) return toast((await r.json().catch(() => ({}))).error || 'Couldn’t save that recording');
    if (!prefs.clips.includes(name)) prefs.clips.push(name);
    toast('Recording added'); app.save(); load();
  }
  async function removeClip(c) {
    await fetch(`/api/trace/clip?name=${encodeURIComponent(c)}&clear=1`, { method: 'POST', headers: { 'X-God-Mix': '1' } });
    prefs.clips = prefs.clips.filter(x => x !== c); app.save(); load();
  }

  // ── checking a leak ──
  const chk = $('#ttCheck', dlg), chkFile = $('input', chk), result = $('#ttResult', dlg);
  const check = async f => {
    if (!f) return;
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    result.hidden = false; result.className = 'tt-result'; result.innerHTML = `<div class="tt-wait"><i></i>Listening to <b>${esc(f.name)}</b> for the tags…</div>`;
    try {
      const r = await fetch(`/api/trace/check?ext=${encodeURIComponent(ext)}`, { method: 'POST', headers: { 'X-God-Mix': '1' }, body: f });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.status);
      app.watchJobs();
      for (;;) {
        await new Promise(res => setTimeout(res, 700));
        if (!layer.isConnected) return;
        const k = (await api.json('/api/jobs')).find(x => x.id === j.id);
        if (!k || k.status === 'error') throw new Error(k?.error || 'the check stopped');
        if (k.status === 'done') return showMatch(k.result.match, f.name);
      }
    } catch (err) { result.className = 'tt-result bad'; result.innerHTML = `Couldn’t check it: ${esc(err.message)}`; }
  };
  const showMatch = (m, file) => {
    result.className = `tt-result ${m.verdict}`;
    const rows = (m.matches || []).slice(0, 4).map(x => `<div class="tt-row"><b>${esc(x.recipient)}</b><span>${esc(x.title)}${x.version ? ` <span class="dim">· ${esc(x.version)}</span>` : ''} <span class="dim">· ${esc(x.made.slice(0, 10))}</span></span>
      <span class="tt-meter"><i style="width:${Math.max(0, Math.min(100, Math.round(x.score * 140)))}%"></i></span></div>`).join('');
    result.innerHTML = `<div class="tt-verdict">${m.verdict === 'match' ? ICON.check : ICON.search}<span><b>${esc(m.msg)}</b><small class="dim">${esc(file)}</small></span></div>${rows ? `<div class="tt-scores">${rows}</div>` : ''}`;
  };
  chk.onclick = () => chkFile.click();
  chk.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); chkFile.click(); } };
  chkFile.onchange = () => check(chkFile.files[0]);
  chk.addEventListener('dragover', e => { e.preventDefault(); chk.classList.add('drop'); });
  chk.addEventListener('dragleave', () => chk.classList.remove('drop'));
  chk.addEventListener('drop', e => { e.preventDefault(); chk.classList.remove('drop'); check(e.dataTransfer.files[0]); });

  // ── go ──
  const go = () => {
    if (add.value.trim()) addPeople(add.value);
    if (!prefs.people.length) { add.focus(); return toast('Add who it’s for: one name per copy'); }
    if (!prefs.phrase.trim() && !prefs.clips.length) return toast('Type some words for the tag, or add a recording');
    if (!prefs.formats.length) return toast('Pick MP3, WAV or both');
    app.startJob({ kind: 'trace', album: G.aid, items: songs().map(s => ({ id: s, title: app.pretty(s) })), version: prefs.version,
      recipients: prefs.people, phrase: prefs.phrase.trim(), voice: prefs.voice, say_name: prefs.say_name, clips: prefs.clips,
      density: prefs.density, formats: prefs.formats });
    close();
  };
  $('#ttGo', dlg).onclick = go;
  layer.addEventListener('pointerdown', e => { if (e.target === layer) close(); });
  layer.addEventListener('click', e => { if (e.target.closest('[data-x]')) close(); });
  const onKey = e => {
    if (!pick.hidden && pickKey(e)) { e.stopPropagation(); return; }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); go(); }
    else { if (e.target === add) peopleKey(e); e.stopPropagation(); }       // typing here never triggers the app's shortcuts
  };
  document.addEventListener('keydown', onKey, true);
  paint(); load();
  (prefs.people.length ? $('#ttPhrase', dlg) : add).focus();
}
