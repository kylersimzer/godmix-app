// Writes every GODMIX brand file into design/ and copies the ones the app uses into app/web/assets.
// SVGs are written directly; PNGs are rendered from them with headless Chrome or Edge
// (set GODMIX_BROWSER to use another Chromium; Chrome is tried first, as headless Edge can refuse to write screenshots). Usage: node design/build.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { INKS, markSVG, tileSVG, lockupSVG, bannerSVG } from './brand.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const ASSETS = path.join(ROOT, 'app', 'web', 'assets');
const out = (...p) => { const f = path.join(HERE, ...p); fs.mkdirSync(path.dirname(f), { recursive: true }); return f; };
const write = (rel, text) => { fs.writeFileSync(out(rel), text); console.log('  wrote', rel); };

// ── a browser to rasterise with ──
const BROWSERS = [process.env.GODMIX_BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
const BROWSER = BROWSERS.find(b => b && fs.existsSync(b));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'godmix-design-'));

// Render an SVG to a PNG at w × h. Text uses Geist from Google Fonts, so the page waits for it.
function png(rel, svg, w, h, { bg = 'transparent' } = {}) {
  if (!BROWSER) { console.log('  skipped', rel, '(no Edge/Chrome found; set GODMIX_BROWSER)'); return; }
  const page = path.join(TMP, 'p.html');
  fs.writeFileSync(page, `<!doctype html><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@500;600&family=Geist+Mono:wght@400&display=block" rel="stylesheet">
<style>html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden;background:${bg}}svg{display:block;width:${w}px;height:${h}px}</style>${svg}`);
  const file = out(rel);
  execFileSync(BROWSER, ['--headless=new', '--disable-gpu', `--user-data-dir=${path.join(TMP, 'profile')}`, '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1',
    '--default-background-color=00000000', '--virtual-time-budget=4000', `--window-size=${w},${h}`, `--screenshot=${file}`,
    pathToFileURL(page).href], { stdio: 'ignore' });
  const b = fs.readFileSync(file), pw = b.readUInt32BE(16), ph = b.readUInt32BE(20);
  console.log(`  rendered ${rel} (${pw}×${ph})`);
}
const sized = (svg, w, h) => svg.replace(/width="[^"]+" height="[^"]+"/, `width="${w}" height="${h}"`);

// An album's loudness, for the banners: the demo album (000) in its running order.
function albumCurve() {
  for (const id of ['demo', '000']) {
    const f = path.join(ROOT, 'app', 'data', `${id}.json`);
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8')).tracks.flatMap(t => [...t.curve, -40, -40]);
  }
  return Array.from({ length: 600 }, (_, i) => -16 + 6 * Math.sin(i / 9) * Math.sin(i / 53));   // stand-in shape
}

console.log('GODMIX design →', path.relative(ROOT, HERE));

// ── the mark ──
for (const [name, ink] of Object.entries(INKS)) {
  write(`logo/godmix-mark-${name}.svg`, markSVG(ink, { size: 24 }));
  write(`logo/godmix-mark-${name}-cropped.svg`, markSVG(ink, { size: 210, crop: true }));
}
png('logo/godmix-mark-white-1024.png', markSVG(INKS.white, { size: 1024 }), 1024, 1024);
png('logo/godmix-mark-toned-1024.png', markSVG(INKS.toned, { size: 1024 }), 1024, 1024);
png('logo/godmix-mark-black-1024.png', markSVG(INKS.black, { size: 1024 }), 1024, 1024);
png('logo/godmix-mark-white-on-black-1024.png', markSVG(INKS.white, { size: 1024 }), 1024, 1024, { bg: '#000' });
png('logo/godmix-mark-toned-on-black-1024.png', markSVG(INKS.toned, { size: 1024 }), 1024, 1024, { bg: '#000' });
// 4K (4096 px square)
png('logo/godmix-mark-white-4096.png', markSVG(INKS.white, { size: 4096 }), 4096, 4096);
png('logo/godmix-mark-toned-4096.png', markSVG(INKS.toned, { size: 4096 }), 4096, 4096);
png('logo/godmix-mark-black-4096.png', markSVG(INKS.black, { size: 4096 }), 4096, 4096);
png('logo/godmix-mark-white-on-black-4096.png', markSVG(INKS.white, { size: 4096 }), 4096, 4096, { bg: '#000' });
png('logo/godmix-mark-toned-on-black-4096.png', markSVG(INKS.toned, { size: 4096 }), 4096, 4096, { bg: '#000' });
// social profile picture: white mark on black, padded so it sits inside the circle sites crop to
png('logo/godmix-profile-4096.png', tileSVG(4096, { radius: 0, pad: 0.17, bg: '#000' }), 4096, 4096, { bg: '#000' });

// ── the lockup ──
for (const [name, ink, text] of [['white', INKS.white, '#ffffff'], ['toned', INKS.toned, '#ecebe6'], ['black', INKS.black, '#08090a']]) {
  const svg = lockupSVG(ink, { height: 64, text });
  write(`logo/godmix-lockup-${name}.svg`, svg);
  const w = Math.ceil(+/viewBox="0 0 ([\d.]+)/.exec(svg)[1]);
  png(`logo/godmix-lockup-${name}-2x.png`, sized(svg, w * 2, 128), w * 2, 128);
  const h4 = Math.round((3840 / w) * 64);                         // 4K wide (3840 px)
  png(`logo/godmix-lockup-${name}-3840.png`, sized(svg, 3840, h4), 3840, h4);
}

// ── icons ──
write('icons/favicon.svg', tileSVG(32));
png('icons/favicon-16.png', tileSVG(16, { pad: 0.1 }), 16, 16);
png('icons/favicon-32.png', tileSVG(32, { pad: 0.11 }), 32, 32);
png('icons/apple-touch-icon.png', tileSVG(180, { radius: 0, pad: 0.16 }), 180, 180);
png('icons/icon-192.png', tileSVG(192), 192, 192);
png('icons/icon-512.png', tileSVG(512), 512, 512);
png('icons/icon-512-maskable.png', tileSVG(512, { radius: 0, pad: 0.24 }), 512, 512);

// ── banners ──
const curve = albumCurve();
const banners = [
  ['banners/godmix-banner-x-1500x500.png', 1500, 500, {}],
  ['banners/godmix-banner-github-1280x640.png', 1280, 640, { align: 'center' }],
  ['banners/godmix-banner-readme-1600x480.png', 1600, 480, {}],
  ['banners/godmix-link-preview-1200x630.png', 1200, 630, { align: 'center' }],
  ['banners/godmix-wallpaper-3840x2160.png', 3840, 2160, { align: 'center' }],     // 4K UHD
];
for (const [rel, w, h, o] of banners) {
  write(rel.replace('.png', '.svg'), bannerSVG(w, h, { curve, ...o }));
  png(rel, bannerSVG(w, h, { curve, ...o }), w, h, { bg: '#000' });
}

// ── what the app serves ──
fs.mkdirSync(ASSETS, { recursive: true });
for (const [from, to] of [['icons/favicon.svg', 'favicon.svg'], ['icons/favicon-32.png', 'favicon-32.png'], ['icons/apple-touch-icon.png', 'apple-touch-icon.png'],
  ['icons/icon-192.png', 'icon-192.png'], ['icons/icon-512.png', 'icon-512.png'], ['icons/icon-512-maskable.png', 'icon-512-maskable.png'],
  ['logo/godmix-mark-current-cropped.svg', 'mark.svg'], ['banners/godmix-link-preview-1200x630.png', 'link-preview.png']]) {
  const src = path.join(HERE, from);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(ASSETS, to));
}
console.log('  copied app icons to app/web/assets');
fs.rmSync(TMP, { recursive: true, force: true });
