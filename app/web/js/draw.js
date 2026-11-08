// Canvas drawing: waveforms (player and details panel) and the album energy arc.
//
// Waveforms are drawn the way stems.fm draws its tracks: a mirrored shape at pixel resolution, a faint outline
// for the peaks and a solid body for the RMS (the level you hear), from the envelope build_data.py stores
// (40 frames a second, peak and RMS as bytes on a −60…0 dBFS scale).
import { cssVar } from './util.js';

export function sizeCanvas(cv) {
  const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
  return [g, w, h];
}

// The envelope of a track or version ({env: base64}), decoded once into linear peak and RMS arrays.
function decode(o) {
  if (o._env) return o._env;
  const raw = atob(o.env || ''), n = raw.length >> 1, peak = new Float32Array(n), rms = new Float32Array(n);
  const lin = b => (b ? 10 ** ((-60 + (b / 255) * 60) / 20) : 0);
  for (let i = 0; i < n; i++) { peak[i] = lin(raw.charCodeAt(2 * i)); rms[i] = lin(raw.charCodeAt(2 * i + 1)); }
  return (o._env = { peak, rms });
}
// …then reduced to one value per pixel column (cached per width): the loudest peak, the mean RMS power.
function columns(o, cols) {
  if (o._cols?.n === cols) return o._cols;
  const { peak, rms } = decode(o), n = peak.length, pk = new Float32Array(cols), rm = new Float32Array(cols);
  for (let c = 0; c < cols; c++) {
    const a = Math.floor((c * n) / cols), z = Math.max(a + 1, Math.floor(((c + 1) * n) / cols));
    let p = 0, s = 0;
    for (let f = a; f < z && f < n; f++) { if (peak[f] > p) p = peak[f]; s += rms[f] * rms[f]; }
    pk[c] = p; rm[c] = Math.sqrt(s / (z - a));
  }
  return (o._cols = { n: cols, pk, rm });
}
function mirror(g, arr, x0, cy, half, gain, from = 0, to = arr.length) {
  g.beginPath(); g.moveTo(x0 + from, cy);
  for (let i = from; i < to; i++) g.lineTo(x0 + i + 0.5, cy - Math.min(1, arr[i] * gain) * half);
  for (let i = to - 1; i >= from; i--) g.lineTo(x0 + i + 0.5, cy + Math.min(1, arr[i] * gain) * half);
  g.closePath();
}

// A waveform. `pos` 0–1 is the playhead (what's played is lit), `hover` previews a seek, `loop` {a, b, on} and
// `marks` [t…] are fractions of the width.
export function drawWave(cv, o, { pos = -1, loop = null, marks = [], hover = -1 } = {}) {
  const [g, w, h] = sizeCanvas(cv);
  const ink = cssVar('--ink'), on = cssVar('--wave-on');
  const cy = h / 2, half = h / 2 - 1;
  g.fillStyle = `rgba(${ink},.14)`; g.fillRect(0, cy - 0.5, w, 1);          // a hairline, so silence still reads
  if (!o || !o.env) return;
  if (loop) {
    g.fillStyle = loop.on ? 'rgba(127,127,127,.16)' : 'rgba(127,127,127,.07)';
    g.fillRect(loop.a * w, 0, (loop.b - loop.a) * w, h);
  }
  const cols = Math.max(1, Math.round(w)), { pk, rm } = columns(o, cols);
  const paint = (peakCol, rmsCol, from, to) => {
    if (to <= from) return;
    g.fillStyle = peakCol; mirror(g, pk, 0, cy, half, 1, from, to); g.fill();
    g.fillStyle = rmsCol; mirror(g, rm, 0, cy, half, 2, from, to); g.fill();
  };
  const p = pos >= 0 ? Math.round(pos * cols) : 0, hv = hover >= 0 ? Math.round(hover * cols) : 0;
  paint(`rgba(${ink},.16)`, `rgba(${ink},.34)`, Math.max(p, hv), cols);              // still to come
  if (hv > p) paint(`rgba(${ink},.26)`, `rgba(${ink},.55)`, p, hv);                  // where a click would seek to
  paint(`rgba(${ink},.42)`, on, 0, p);                                               // played
  if (loop) { g.fillStyle = loop.on ? on : `rgba(${ink},.4)`; g.fillRect(loop.a * w, 0, 1, h); g.fillRect(loop.b * w - 1, 0, 1, h); }
  g.fillStyle = on;
  for (const m of marks) { g.beginPath(); g.arc(m * w, 2.5, 2.5, 0, Math.PI * 2); g.fill(); }
  if (pos >= 0) g.fillRect(Math.round(pos * w) - 0.5, 0, 1.5, h);
}

// The energy arc: each track's loudness curve laid end to end in running order, gaps included.
export function drawArc(cv, { order, byName, starts, total, cur, sel, pos }) {
  const [g, w, h] = sizeCanvas(cv);
  if (!order.length || !total) return;
  const top = 16, bot = h - 1;
  const y = l => bot - Math.max(0, Math.min(1, (l + 36) / 30)) * (bot - top);
  const fg = cssVar('--fg'), f3 = cssVar('--fg-3'), f4 = cssVar('--fg-4'), on = cssVar('--wave-on');
  g.font = `500 10px ${cssVar('--mono')}`; g.textBaseline = 'top';
  order.forEach((n, i) => {
    const t = byName[n], x0 = (starts[n] / total) * w, x1 = ((starts[n] + t.dur) / total) * w, isCur = n === cur, isSel = n === sel;
    if (isCur || isSel) { g.fillStyle = 'rgba(127,127,127,.09)'; g.fillRect(x0, 0, x1 - x0, h); }
    g.beginPath(); g.moveTo(x0, bot);
    t.curve.forEach((l, k) => g.lineTo(x0 + (k / (t.curve.length - 1)) * (x1 - x0), y(l)));
    g.lineTo(x1, bot); g.closePath();
    g.fillStyle = isCur ? on : f4; g.globalAlpha = isCur ? 0.9 : i % 2 ? 0.75 : 1; g.fill(); g.globalAlpha = 1;
    g.fillStyle = isCur || isSel ? fg : f3; g.fillText(String(i + 1).padStart(2, '0'), x0 + 3, 2);
  });
  if (cur != null && pos != null) { const x = ((starts[cur] + pos) / total) * w; g.fillStyle = fg; g.fillRect(x - 0.5, 0, 1.5, h); }
}
