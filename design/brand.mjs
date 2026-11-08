// GODMIX brand: the mark, the lockup, icons and banners, all drawn as SVG from one place.
//
// The mark is stems.fm mark 136, "Three dials" (after 106 · Dial): three knobs at three settings,
// from the stems.fm brand marks. It is copied here, not imported, so this repo stands on its own.
// Drawn on a 24 × 24 grid like every stems.fm mark.

const f = n => +n.toFixed(2);
const pt = (cx, cy, rad, deg) => { const a = ((deg - 90) * Math.PI) / 180; return [f(cx + rad * Math.cos(a)), f(cy + rad * Math.sin(a))]; };
const ring = (cx, cy, rad, w, stroke) => `<circle cx="${cx}" cy="${cy}" r="${rad}" fill="none" stroke="${stroke}" stroke-width="${w}"/>`;
const ray = (cx, cy, r0, r1, deg, w, stroke) => {
  const [x0, y0] = pt(cx, cy, r0, deg), [x1, y1] = pt(cx, cy, r1, deg);
  return `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" stroke="${stroke}" stroke-width="${w}" stroke-linecap="round"/>`;
};

// Each dial: where its pointer sits (degrees, 0 = up). Left to right: off, a little, most of the way.
export const DIALS = [-90, 30, 120];

// The three inks, left to right.
//   white: the app logo (all three dials pure white)
//   toned: the stems.fm look (one ink at 100 / 70 / 45 %)
//   black: for light backgrounds;  current: follows CSS currentColor
// An ink is a colour, optionally "colour@opacity". Opacity is applied to the whole dial (a group), so the
// pointer doesn't show darker where it overlaps its ring, as it would with an rgba stroke.
export const INKS = {
  white: ['#ffffff', '#ffffff', '#ffffff'],
  toned: ['#ecebe6', '#ecebe6@0.7', '#ecebe6@0.45'],
  black: ['#08090a', '#08090a', '#08090a'],
  current: ['currentColor', 'currentColor', 'currentColor'],
};

// The mark's shapes, on the 24 grid (the dials sit on the middle row: x 1.65–22.35, y 8.65–15.35).
export const markShapes = (ink = INKS.white) => DIALS.map((a, i) => {
  const [col, op] = ink[i].split('@'), dial = ring(5 + i * 7, 12, 2.7, 1.3, col) + ray(5 + i * 7, 12, 0, 2, a, 1.2, col);
  return op ? `<g opacity="${op}">${dial}</g>` : dial;
}).join('');

// Tight box around the mark, with a little room for the stroke.
export const MARK_BOX = { x: 1.5, y: 8.5, w: 21, h: 7 };

// The mark on its own: square (24 grid, as stems.fm draws it) or cropped to the dials.
export const markSVG = (ink = INKS.white, { size = 24, crop = false } = {}) => {
  const vb = crop ? `${MARK_BOX.x} ${MARK_BOX.y} ${MARK_BOX.w} ${MARK_BOX.h}` : '0 0 24 24';
  const [w, h] = crop ? [size, f((size * MARK_BOX.h) / MARK_BOX.w)] : [size, size];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="${w}" height="${h}" fill="none">${markShapes(ink)}</svg>`;
};

// Icons: the mark on a rounded black tile, so it reads on light and dark tabs alike.
// `pad` is the share of the tile's width left either side of the dials.
export const tileSVG = (size, { radius = 0.23, pad = 0.14, bg = '#08090a', ink = INKS.white } = {}) => {
  const inner = 24 * (1 - 2 * pad), k = inner / MARK_BOX.w;
  const tx = f(24 * pad - MARK_BOX.x * k), ty = f(12 - (MARK_BOX.y + MARK_BOX.h / 2) * k);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}">` +
    (bg ? `<rect width="24" height="24" rx="${f(24 * radius)}" fill="${bg}"/>` : '') +
    `<g transform="translate(${tx} ${ty}) scale(${f(k)})">${markShapes(ink)}</g></svg>`;
};

// The wordmark is set in Geist (the stems.fm typeface). SVG text needs the font installed or loaded,
// so the PNG renders are the dependable copies; the SVG lockups fall back to Inter / Segoe UI.
export const FONT = `'Geist', 'Inter', 'Segoe UI', system-ui, sans-serif`;
export const MONO = `'Geist Mono', ui-monospace, 'SF Mono', Consolas, monospace`;
export const WORD = 'GODMIX';

// Mark + wordmark side by side. Height drives everything; the width is an estimate of Geist's advance.
export const lockupSVG = (ink = INKS.white, { height = 64, text = '#ffffff' } = {}) => {
  const markW = height * 1.55, gap = height * 0.34, fs = height * 0.62;
  const textW = fs * 0.66 * WORD.length, w = f(markW + gap + textW);
  const k = markW / MARK_BOX.w;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${height}" width="${w}" height="${height}">` +
    `<g transform="translate(${f(-MARK_BOX.x * k)} ${f(height / 2 - 12 * k)}) scale(${f(k)})">${markShapes(ink)}</g>` +
    `<text x="${f(markW + gap)}" y="${f(height / 2)}" dominant-baseline="central" font-family="${FONT}" font-weight="600" font-size="${f(fs)}" letter-spacing="${f(fs * 0.04)}" fill="${text}">${WORD}</text></svg>`;
};

// A banner: black, a soft light from above, the lockup, a line of mono text, and an album's loudness
// drawn as thin bars along the bottom (the only "colour" on stems.fm comes from the music itself).
export function bannerSVG(W, H, { curve = [], tagline = 'A/B · VERSIONS · RUNNING ORDER', align = 'left', ink = INKS.white } = {}) {
  const lockH = Math.round(H * 0.15), lw = lockH * 1.55 + lockH * 0.34 + lockH * 0.62 * 0.66 * WORD.length;
  const x0 = align === 'center' ? (W - lw) / 2 : W * 0.08, y0 = H * (align === 'center' ? 0.34 : 0.3);
  const bars = [], n = Math.min(curve.length, Math.floor(W / 6)), base = H * 0.97, room = H * 0.3;
  for (let i = 0; i < n; i++) {
    const v = curve[Math.floor((i / n) * curve.length)], h = Math.max(1, ((v + 40) / 34) * room);
    const fade = Math.min(1, i / (n * 0.12), (n - i) / (n * 0.12));
    bars.push(`<rect x="${f(i * (W / n))}" y="${f(base - h)}" width="${f((W / n) * 0.42)}" height="${f(h)}" rx="${f((W / n) * 0.2)}" fill="url(#bar)" opacity="${f(0.35 + 0.65 * fade)}"/>`);
  }
  const k = (lockH * 1.55) / MARK_BOX.w, fs = lockH * 0.62;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
<defs><radialGradient id="glow" cx="50%" cy="-10%" r="75%"><stop offset="0" stop-color="#fff" stop-opacity=".11"/><stop offset=".55" stop-color="#fff" stop-opacity=".025"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
<linearGradient id="bar" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".26"/><stop offset="1" stop-color="#fff" stop-opacity=".03"/></linearGradient>
<linearGradient id="hair" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".18"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>
<rect width="${W}" height="${H}" fill="#000"/><rect width="${W}" height="${H}" fill="url(#glow)"/>
${bars.join('')}
<rect x="0" y="${f(base - room - H * 0.04)}" width="${W}" height="1" fill="url(#hair)"/>
<g transform="translate(${f(x0 - MARK_BOX.x * k)} ${f(y0 + lockH / 2 - 12 * k)}) scale(${f(k)})">${markShapes(ink)}</g>
<text x="${f(x0 + lockH * 1.55 + lockH * 0.34)}" y="${f(y0 + lockH / 2)}" dominant-baseline="central" font-family="${FONT}" font-weight="600" font-size="${f(fs)}" letter-spacing="${f(fs * 0.04)}" fill="#fff">${WORD}</text>
<text x="${align === 'center' ? W / 2 : f(x0)}" y="${f(y0 + lockH + H * 0.1)}" text-anchor="${align === 'center' ? 'middle' : 'start'}" font-family="${MONO}" font-size="${f(H * 0.036)}" letter-spacing="${f(H * 0.006)}" fill="#fff" fill-opacity=".52">${tagline}</text>
</svg>`;
}
