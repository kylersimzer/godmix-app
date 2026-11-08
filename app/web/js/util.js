// Small helpers shared by every module: DOM, formatting, toasts, tooltips and the icon set.
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const enc = encodeURIComponent;
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmt = s => { s = Math.max(0, s || 0); return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0'); };
export const fmtLong = s => { s = Math.max(0, Math.round(s || 0)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : fmt(s); };
export const pad2 = n => String(n).padStart(2, '0');
export const cssVar = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
export const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = isMac ? '⌘' : 'Ctrl';
export const debounce = (fn, ms) => { let t; const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; d.flush = () => { clearTimeout(t); fn(); }; return d; };
export const store = {     // localStorage that never throws (private windows, blocked storage)
  get(k, d) { try { const v = localStorage.getItem('godmix.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('godmix.' + k, JSON.stringify(v)); } catch {} },
};

// ── toasts, optionally with one action ("Undo") ──
export function toast(msg, { action, onAction, ms = 2600 } = {}) {
  let host = $('.toasts');
  if (!host) { host = document.createElement('div'); host.className = 'toasts'; host.setAttribute('role', 'status'); document.body.append(host); }
  while (host.children.length > 2) host.firstChild.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span>${esc(msg)}</span>` + (action ? `<button class="btn line">${esc(action)}</button>` : '');
  if (action) el.querySelector('button').onclick = () => { onAction(); el.remove(); };
  host.append(el);
  setTimeout(() => el.remove(), ms);
}

// ── tooltips: any element with data-tip="Label" (and optional data-key="Space") ──
export function tooltips() {
  let tip, timer, target;
  const hide = () => { clearTimeout(timer); tip?.remove(); tip = null; target = null; };
  document.addEventListener('pointerover', e => {
    const el = e.target.closest('[data-tip]');
    if (el === target) return;
    hide();
    if (!el || e.pointerType === 'touch') return;
    target = el;
    timer = setTimeout(() => {
      tip = document.createElement('div');
      tip.className = 'tip';
      tip.innerHTML = esc(el.dataset.tip) + (el.dataset.key ? el.dataset.key.split(' ').map(k => `<kbd>${esc(k)}</kbd>`).join('') : '');
      document.body.append(tip);
      const r = el.getBoundingClientRect(), t = tip.getBoundingClientRect();
      const above = r.top > t.height + 12;
      tip.style.left = clamp(r.left + r.width / 2 - t.width / 2, 8, innerWidth - t.width - 8) + 'px';
      tip.style.top = (above ? r.top - t.height - 6 : r.bottom + 6) + 'px';
    }, 450);
  });
  document.addEventListener('pointerdown', hide, true);
  document.addEventListener('keydown', hide, true);
  addEventListener('blur', hide);
}

// ── icons (16 grid, stroke 1.5, like Linear's) ──
const I = d => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
export const ICON = {
  play: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 2.8v10.4c0 .6.6.9 1.1.6l8.2-5.2a.7.7 0 000-1.2L5.6 2.2c-.5-.3-1.1 0-1.1.6z" fill="currentColor"/></svg>`,
  pause: `<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="2.5" width="3.2" height="11" rx="1" fill="currentColor"/><rect x="9.3" y="2.5" width="3.2" height="11" rx="1" fill="currentColor"/></svg>`,
  prev: I('<path d="M4 3v10M13 3.6v8.8a.5.5 0 01-.8.4L6.5 8.4a.5.5 0 010-.8l5.7-4.4a.5.5 0 01.8.4z"/>'),
  next: I('<path d="M12 3v10M3 3.6v8.8a.5.5 0 00.8.4l5.7-4.4a.5.5 0 000-.8L3.8 3.2a.5.5 0 00-.8.4z"/>'),
  search: I('<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/>'),
  folder: I('<path d="M2 4.5A1.5 1.5 0 013.5 3h2.6l1.5 1.5h4.9A1.5 1.5 0 0114 6v5.5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5z"/>'),
  file: I('<path d="M4 2h5l3 3v8.5a.5.5 0 01-.5.5h-7a.5.5 0 01-.5-.5v-11A.5.5 0 014 2z"/><path d="M9 2v3h3"/>'),
  up: I('<path d="M8 13V3M4 7l4-4 4 4"/>'),
  down: I('<path d="M8 3v10M4 9l4 4 4-4"/>'),
  copy: I('<rect x="5" y="5" width="8.5" height="8.5" rx="1.5"/><path d="M3 10.5V3.8A1.3 1.3 0 014.3 2.5H11"/>'),
  reset: I('<path d="M2.5 8a5.5 5.5 0 105.5-5.5c-1.9 0-3.4.9-4.5 2.2"/><path d="M3 2v3h3"/>'),
  undo: I('<path d="M5 4L2 7l3 3"/><path d="M2.5 7H10a3.5 3.5 0 010 7H8"/>'),
  redo: I('<path d="M11 4l3 3-3 3"/><path d="M13.5 7H6a3.5 3.5 0 000 7h2"/>'),
  sun: I('<circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1"/>'),
  moon: I('<path d="M13.5 9.5A5.5 5.5 0 016.5 2.5a5.5 5.5 0 107 7z"/>'),
  keyboard: I('<rect x="1.5" y="4" width="13" height="8" rx="1.5"/><path d="M4 7h.01M6.5 7h.01M9 7h.01M11.5 7h.01M5 9.5h6"/>'),
  panel: I('<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M10 2.5v11"/>'),
  home: I('<path d="M2.5 7L8 2.5 13.5 7v6a.5.5 0 01-.5.5H3a.5.5 0 01-.5-.5z"/><path d="M6.5 13.5V10h3v3.5"/>'),
  note: I('<path d="M3 3.5h10M3 6.5h10M3 9.5h6"/><path d="M10.5 13.5l3-3"/>'),
  loop: I('<path d="M3 7V6a2 2 0 012-2h7l-2-2M13 9v1a2 2 0 01-2 2H4l2 2"/>'),
  waves: I('<path d="M2 8h1M4.5 5v6M7 3v10M9.5 6v4M12 4.5v7M14 8h.01"/>'),
  list: I('<path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01"/>'),
  close: I('<path d="M4 4l8 8M12 4l-8 8"/>'),
  check: I('<path d="M3 8.5l3 3 7-7"/>'),
  enter: I('<path d="M13 3v5a2 2 0 01-2 2H3M6 7l-3 3 3 3"/>'),
  album: I('<circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="1.5"/>'),
  dial: I('<circle cx="8" cy="8" r="5.5"/><path d="M8 8l2.8-2.8"/>'),
  more: I('<path d="M3.5 8h.01M8 8h.01M12.5 8h.01"/>'),
  ext: I('<path d="M9 2.5h4.5V7M13.5 2.5L7 9M11 9.5v3a1 1 0 01-1 1H3.5a1 1 0 01-1-1V6a1 1 0 011-1h3"/>'),
  plus: I('<path d="M8 3v10M3 8h10"/>'),
  trace: I('<path d="M2.5 3.5v3.6c0 .4.2.8.4 1l5.6 5.6a1 1 0 001.4 0l3.2-3.2a1 1 0 000-1.4L7.5 3.5c-.3-.3-.6-.5-1-.5H3a.5.5 0 00-.5.5z"/><circle cx="5.3" cy="5.8" r=".9"/>'),
  edit: I('<path d="M10.5 3l2.5 2.5L6 12.5 3 13l.5-3z"/>'),
  pad: I('<path d="M3.5 2.5h9v8l-3 3h-6z"/><path d="M12.5 10.5h-3v3M6 6h4M6 8.5h2.5"/>'),
};
// status icons: empty dial (no status), half-turned dial (needs work), full dial with tick (approved)
export const STATUS = {
  '': { label: 'No status', icon: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="8" cy="8" r="5.5" stroke-dasharray="2.2 2"/></svg>` },
  work: { label: 'Needs work', icon: `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.5a3.5 3.5 0 010 7z" fill="currentColor"/></svg>` },
  done: { label: 'Approved', icon: `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2" fill="currentColor"/><path d="M5.4 8.2l1.8 1.8 3.4-3.6" fill="none" stroke="var(--bg)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>` },
};
export const STATUS_ORDER = ['', 'work', 'done'];
