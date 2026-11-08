// The notepad: a sticky note that drops down from the Notes button, for keeping track of the work on an album
// (to-dos, ideas, lyrics, what to try next) without another app. Tabs can be added, renamed (double-click) and
// closed. The text is saved with the album's state (pad: {tabs: [{id, title, text}], active}); where the note
// sits and its size are per browser.
import { $, esc, ICON, store, toast } from './util.js';

const fresh = () => ({ tabs: [{ id: 't1', title: 'To do', text: '' }], active: 't1' });

export function createNotepad(app) {
  let el = null;
  const pad = () => {
    const S = app.G.S;
    if (!S.pad || !Array.isArray(S.pad.tabs) || !S.pad.tabs.length) S.pad = fresh();
    if (!S.pad.tabs.some(t => t.id === S.pad.active)) S.pad.active = S.pad.tabs[0].id;
    return S.pad;
  };
  const cur = () => pad().tabs.find(t => t.id === pad().active);

  function render() {
    if (!el) return;
    const p = pad();
    $('.pad-tabs', el).innerHTML = p.tabs.map(t => `<button class="pad-tab${t.id === p.active ? ' on' : ''}" data-tab="${t.id}" data-tip="Double-click to rename">
      <span>${esc(t.title || 'Untitled')}</span>${p.tabs.length > 1 ? `<i data-close="${t.id}" aria-label="Close tab">${ICON.close}</i>` : ''}</button>`).join('') +
      `<button class="pad-add" data-add data-tip="New tab">${ICON.plus}</button>`;
    const ta = $('textarea', el);
    if (ta.value !== cur().text) ta.value = cur().text;
    ta.placeholder = `${cur().title || 'Notes'}…`;
    $('.pad-album', el).textContent = app.G.data ? app.G.data.title : '';
  }

  function open() {
    if (el) { el.querySelector('textarea').focus(); return; }
    el = document.createElement('div');
    el.className = 'notepad';
    el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Notes');
    el.innerHTML = `<div class="pad-hd"><b>Notes</b><span class="pad-album dim"></span><span class="grow"></span><button class="btn icon" data-x data-tip="Close" data-key="P">${ICON.close}</button></div>
      <div class="pad-tabs"></div><textarea spellcheck="true"></textarea>`;
    const geo = store.get('pad.geo', null);
    if (geo) Object.assign(el.style, { left: geo.x + 'px', top: geo.y + 'px', width: geo.w + 'px', height: geo.h + 'px' });
    document.body.append(el);
    keepOnScreen();
    render();
    $('#padBtn')?.setAttribute('aria-pressed', 'true');
    const ta = $('textarea', el);
    ta.focus();
    ta.addEventListener('input', () => { cur().text = ta.value; app.save(); });
    ta.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape') ta.blur(); });
    el.addEventListener('click', e => {
      const x = e.target.closest('[data-close]');
      if (x) return closeTab(x.dataset.close);
      const t = e.target.closest('[data-tab]');
      if (t) { pad().active = t.dataset.tab; app.save(); render(); ta.focus(); return; }
      if (e.target.closest('[data-add]')) return addTab();
      if (e.target.closest('[data-x]')) close();
    });
    el.addEventListener('dblclick', e => { const t = e.target.closest('[data-tab]'); if (t) renameTab(t); });
    // drag by the header; the size comes from the native resize handle (bottom right)
    const hd = $('.pad-hd', el);
    hd.addEventListener('pointerdown', e => {
      if (e.target.closest('button')) return;
      const r = el.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
      hd.setPointerCapture(e.pointerId);
      const move = ev => { el.style.left = ev.clientX - dx + 'px'; el.style.top = ev.clientY - dy + 'px'; keepOnScreen(); };
      const up = () => { hd.removeEventListener('pointermove', move); hd.removeEventListener('pointerup', up); remember(); };
      hd.addEventListener('pointermove', move); hd.addEventListener('pointerup', up);
    });
    new ResizeObserver(() => remember()).observe(el);
  }
  function keepOnScreen() {
    const r = el.getBoundingClientRect();
    el.style.left = Math.max(8, Math.min(innerWidth - 120, r.left)) + 'px';
    el.style.top = Math.max(8, Math.min(innerHeight - 80, r.top)) + 'px';
  }
  function remember() {
    if (!el) return;
    const r = el.getBoundingClientRect();
    store.set('pad.geo', { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
  }
  function close() { if (!el) return; remember(); el.remove(); el = null; $('#padBtn')?.setAttribute('aria-pressed', 'false'); }
  function addTab() {
    const p = pad(), id = 't' + Date.now().toString(36);
    p.tabs.push({ id, title: `Tab ${p.tabs.length + 1}`, text: '' }); p.active = id; app.save(); render();
    renameTab($(`[data-tab="${id}"]`, el));
  }
  function renameTab(btn) {
    const t = pad().tabs.find(x => x.id === btn.dataset.tab), span = btn.querySelector('span');
    const inp = document.createElement('input');
    inp.className = 'pad-rename'; inp.value = t.title; inp.size = Math.max(4, t.title.length);
    span.replaceWith(inp); inp.focus(); inp.select();
    let done = false;
    const finish = ok => { if (done) return; done = true; if (ok) { t.title = inp.value.trim().slice(0, 40) || t.title; app.save(); } render(); };
    inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); });
    inp.addEventListener('blur', () => finish(true));
    inp.addEventListener('click', e => e.stopPropagation());
  }
  function closeTab(id) {
    const p = pad(), i = p.tabs.findIndex(t => t.id === id), gone = p.tabs[i];
    p.tabs.splice(i, 1);
    if (p.active === id) p.active = p.tabs[Math.max(0, i - 1)].id;
    app.save(); render();
    if (gone.text.trim()) toast(`Closed “${gone.title}”`, { action: 'Undo', onAction: () => { p.tabs.splice(i, 0, gone); p.active = gone.id; app.save(); render(); } });
  }
  return { open, close, toggle: () => (el ? close() : open()), render, isOpen: () => !!el };
}
