// What the measurements say about a track, and about the seam between two tracks in the running order.

// Camelot wheel: same key, neighbours (±1, same letter) or relative major/minor (same number) blend.
export function camelotRel(a, b) {
  const pa = /(\d+)([AB])/.exec(a || ''), pb = /(\d+)([AB])/.exec(b || '');
  if (!pa || !pb) return 'unknown';
  const na = +pa[1], nb = +pb[1], d = Math.min((na - nb + 12) % 12, (nb - na + 12) % 12);
  if (na === nb && pa[2] === pb[2]) return 'same';
  if ((d === 1 && pa[2] === pb[2]) || d === 0) return 'compatible';
  return 'clash';
}

// Chips for the gap between track A and track B: [kind, label], kind '' | 'good' | 'warn'.
export function transitionChips(A, B) {
  const chips = [];
  // tempo, treating half and double time as the same feel
  const pct = [1, 2, 0.5].map(r => (B.bpm * r) / A.bpm - 1).reduce((m, r) => (Math.abs(r) < Math.abs(m) ? r : m));
  const tl = `${Math.round(A.bpm)} → ${Math.round(B.bpm)} bpm`;
  if (Math.abs(pct) < 0.03) chips.push(['good', tl + ' · same tempo']);
  else if (Math.abs(pct) < 0.12) chips.push(['', tl + ' · tempo shift']);
  else chips.push(['warn', tl + ' · gear change']);
  // key
  const rel = camelotRel(A.camelot, B.camelot), unsure = !A.key_sure || !B.key_sure, kl = `${A.camelot} → ${B.camelot}`;
  if (rel === 'same') chips.push(['good', kl + ' · same key' + (unsure ? '?' : '')]);
  else if (rel === 'compatible') chips.push(['good', kl + ' · keys blend' + (unsure ? '?' : '')]);
  else chips.push([unsure ? '' : 'warn', kl + (unsure ? ' · key change (unsure)' : ' · key change')]);
  // energy at the seam
  const fades = A.fade_db < -5 || A.end_lufs < -20;
  const slow = B.start_lufs < -20 || B.build_s > 25, instant = B.build_s <= 2;
  const end = fades ? 'fades out' : 'ends loud', start = slow ? 'slow build' : instant ? 'hits instantly' : 'quick build';
  chips.push([fades && slow ? 'warn' : !slow ? 'good' : '', `${end} → ${start}` + (fades && slow ? ' · energy dip' : !fades && instant ? ' · hard cut' : '')]);
  const db = B.bright_hz - A.bright_hz;
  if (Math.abs(db) > 450) chips.push(['warn', db > 0 ? 'gets much brighter' : 'gets much darker']);
  return chips;
}

// One line about the start/end clean-up (albums being mastered only; released albums are never edited).
export function edgeSummary(t) {
  const e = t.edge;
  if (!e) return '';
  if (e.flag) return `Check the start: ${e.flag_reason}`;
  if (!e.cleaned?.length) return '';
  const cut = e.cleaned.find(h => h.action.startsWith('cut'));
  return (cut ? 'Start static removed' : 'Click-free edges') + ` (${e.cleaned.map(h => h.when).filter(Boolean).join(', ')})`;
}
