// Screenshots of the running app for the homepage and README (needs the server running: npm run serve).
// Usage: node design/screenshot.mjs [base url]      default http://localhost:8333
// Writes design/screens/*.png and copies them to app/web/assets/screens/.
// The homepage's shot shows the demo album alone, as a fresh install does: run it against a server whose data has
// only the demo (GODMIX_DATA_DIR=<folder with albums.json filtered to "demo" and demo.json> node app/server.js 8335).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const BASE = process.argv[2] || 'http://localhost:8333';
const BROWSER = [process.env.GODMIX_BROWSER, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(b => b && fs.existsSync(b));
if (!BROWSER) { console.error('No Chrome or Edge found; set GODMIX_BROWSER'); process.exit(1); }
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'godmix-shots-'));

const SHOTS = [
  // [file, path, width, height, scale]
  ['app-dark.png', '/app#/demo/4', 1440, 880, 2],      // the demo album, the one visitors can try at godmix.app
  ['app-dark-1x.png', '/app#/demo/4', 1440, 880, 1],
];
fs.mkdirSync(path.join(HERE, 'screens'), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'app', 'web', 'assets', 'screens'), { recursive: true });
for (const [file, url, w, h, scale] of SHOTS) {
  const out = path.join(HERE, 'screens', file);
  execFileSync(BROWSER, ['--headless=new', '--disable-gpu', `--user-data-dir=${path.join(TMP, 'profile')}`, '--no-first-run', '--hide-scrollbars',
    `--force-device-scale-factor=${scale}`, '--virtual-time-budget=6000', '--autoplay-policy=no-user-gesture-required',
    `--window-size=${w},${h}`, `--screenshot=${out}`, BASE + url], { stdio: 'ignore' });
  fs.copyFileSync(out, path.join(ROOT, 'app', 'web', 'assets', 'screens', file));
  console.log('  wrote design/screens/' + file);
}
fs.rmSync(TMP, { recursive: true, force: true });
