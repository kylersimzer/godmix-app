// Server tests: it serves the app, plays only files listed in the album data, can't be walked out of web/,
// saves state only with the GODMIX header, and answers Range requests. Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'godmix-test-'));
const DATA = path.join(tmp, 'data'), STATE = path.join(tmp, 'state'), AUDIO = path.join(tmp, 'audio');
for (const d of [DATA, STATE, AUDIO]) fs.mkdirSync(d);
const wav = path.join(AUDIO, 'one.wav'), secret = path.join(tmp, 'secret.txt');
fs.writeFileSync(wav, Buffer.from('RIFF0000WAVEfmt ' + 'x'.repeat(200)));
fs.writeFileSync(secret, 'not for the browser');
fs.writeFileSync(path.join(DATA, 'albums.json'), JSON.stringify([{ id: 'T1', title: 'T1', subtitle: 'Test', released: true, tracks: 1 }]));
fs.writeFileSync(path.join(DATA, 'T1.json'), JSON.stringify({ id: 'T1', title: 'T1', released: true, folder: AUDIO, versions_folder: AUDIO,
  tracks: [{ name: 'one.wav', n: 1, title: 'One', paths: { orig: wav, master: wav, versions: { Slow: wav } } }] }));

process.env.GODMIX_DATA_DIR = DATA;
process.env.GODMIX_STATE_DIR = STATE;
const { createServer } = createRequire(import.meta.url)('../app/server.js');
let server, base;
before(() => new Promise(ok => { server = createServer().listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; ok(); }); }));
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const get = (p, h = {}) => fetch(base + p, { headers: h });
const post = (p, body, h = { 'X-God-Mix': '1' }) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(body) });

test('serves the homepage, the app and its static files', async () => {
  for (const p of ['/', '/app', '/css/app.css', '/js/app.js', '/assets/favicon.svg', '/manifest.webmanifest']) assert.equal((await get(p)).status, 200, p);
  assert.match((await get('/js/app.js')).headers.get('content-type'), /javascript/);
});

test('health and album list', async () => {
  const h = await (await get('/api/health')).json();
  assert.equal(h.ok, true); assert.deepEqual(h.albums, ['T1']);
  assert.equal((await (await get('/api/albums')).json())[0].id, 'T1');
});

test('static paths cannot leave web/', async () => {
  for (const p of ['/css/../../server.js', '/js/..%2F..%2Fserver.js', '/assets/%2e%2e/%2e%2e/package.json', '/css/..\\..\\server.js'])
    assert.notEqual((await get(p)).status, 200, p);
});

test('plays only files listed in the album data', async () => {
  assert.equal((await get('/audio/T1/master/one.wav')).status, 200);
  assert.equal((await get('/audio/T1/version/one.wav?v=Slow')).status, 200);
  assert.equal((await get('/audio/T1/version/one.wav?v=Nope')).status, 404);
  assert.equal((await get('/audio/T1/master/' + encodeURIComponent(secret))).status, 404);
  assert.equal((await get('/audio/T1/master/secret.txt')).status, 404);
  assert.equal((await get('/audio/..%2F..%2Fsecret/master/one.wav')).status, 404);
  assert.equal((await get('/data/nope.json')).status, 404);
});

test('range requests return partial content', async () => {
  const r = await get('/audio/T1/master/one.wav', { Range: 'bytes=4-11' });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), `bytes 4-11/${fs.statSync(wav).size}`);
  assert.equal((await r.arrayBuffer()).byteLength, 8);
});

test('jobs: listed, and only valid ones are queued', async () => {
  assert.deepEqual(await (await get('/api/jobs')).json(), []);
  assert.equal((await post('/api/jobs', { kind: 'make', album: 'T1' }, {})).status, 403);
  assert.equal((await post('/api/jobs', { kind: 'make', album: 'NOPE' })).status, 400);
  assert.equal((await post('/api/jobs', { kind: 'make', album: 'T1', tracks: ['../../secret.txt'] })).status, 400);
  assert.equal((await post('/api/jobs', { kind: 'make', album: 'T1', versions: ['Evil'] })).status, 400);
  assert.equal((await post('/api/jobs', { kind: 'export', album: 'T1', items: [{ id: 'nope.wav' }] })).status, 400);
  assert.equal((await post('/api/jobs', { kind: 'rm -rf', album: 'T1' })).status, 400);
  assert.equal((await post('/api/jobs', { kind: 'album', action: 'edit', id: 'NOPE', title: 'x' })).status, 400);
  assert.equal((await post('/api/jobs', { kind: 'album', action: 'add', title: 'x', folder: 'relative/path' })).status, 400);
  assert.equal((await post('/api/jobs', { kind: 'album', action: 'add', title: 'x', folder: path.join(tmp, 'nope') })).status, 400);
  assert.equal((await post('/api/jobs', { kind: 'album', action: 'delete', id: 'T1' })).status, 400);
  assert.deepEqual(await (await get('/api/jobs')).json(), []);
});

test('folder preview lists audio files only, and needs the header', async () => {
  assert.equal((await post('/api/folder', { path: AUDIO }, {})).status, 403);
  const r = await (await post('/api/folder', { path: AUDIO })).json();
  assert.equal(r.ok, true); assert.deepEqual(r.files, ['one.wav']);
  assert.equal((await (await post('/api/folder', { path: 'not/absolute' })).json()).ok, false);
});

test('cover: PNG or JPEG only, set and cleared', async () => {
  assert.equal((await get('/api/cover?album=T1')).status, 404);
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  assert.equal((await fetch(base + '/api/cover?album=T1', { method: 'POST', headers: { 'Content-Type': 'text/html', 'X-God-Mix': '1' }, body: '<b>' })).status, 415);
  assert.equal((await fetch(base + '/api/cover?album=T1', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png })).status, 403);
  assert.equal((await fetch(base + '/api/cover?album=T1', { method: 'POST', headers: { 'Content-Type': 'image/png', 'X-God-Mix': '1' }, body: png })).status, 200);
  assert.equal((await get('/api/cover?album=T1')).status, 200);
  // a JPEG cover must come back as an image, or the browser (nosniff) won't show it
  assert.equal((await fetch(base + '/api/cover?album=T1', { method: 'POST', headers: { 'Content-Type': 'image/jpeg', 'X-God-Mix': '1' }, body: Buffer.from('ffd8ffe0', 'hex') })).status, 200);
  assert.equal((await get('/api/cover?album=T1')).headers.get('content-type'), 'image/jpeg');
  assert.equal((await fetch(base + '/api/cover?album=T1&clear=1', { method: 'POST', headers: { 'X-God-Mix': '1' } })).status, 200);
  assert.equal((await get('/api/cover?album=T1')).status, 404);
});

test('state saves only with the GODMIX header, and round-trips', async () => {
  assert.equal((await post('/api/state?album=T1', { order: [] }, {})).status, 403);
  assert.equal((await post('/api/state?album=NOPE', { order: [] })).status, 404);
  assert.equal((await post('/api/state?album=T1', [1, 2])).status, 400);
  const S = { order: ['one.wav'], notes: { 'one.wav': 'hi' }, marks: { 'one.wav': [{ t: 1.5, text: 'here' }] } };
  assert.equal((await post('/api/state?album=T1', S)).status, 200);
  assert.deepEqual(await (await get('/api/state?album=T1')).json(), S);
  assert.ok(fs.existsSync(path.join(STATE, 'T1.json')));
});

test('Trace Tags: recordings are saved by plain name only, and bad trace jobs are refused', async () => {
  assert.deepEqual(await (await get('/api/trace')).json(), { clips: [], total: 0, recent: [] });
  const up = (name, body = 'RIFF0000WAVEdata') => fetch(`${base}/api/trace/clip?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'X-God-Mix': '1' }, body });
  assert.equal((await up('../escape.wav')).status, 400);
  assert.equal((await up('tag.exe')).status, 400);
  assert.equal((await up('my tag.wav')).status, 200);
  assert.deepEqual((await (await get('/api/trace')).json()).clips, ['my tag.wav']);
  assert.equal((await get('/api/trace/clip?name=my%20tag.wav')).status, 200);
  assert.equal((await get('/api/trace/clip?name=..%2F..%2Fsecret.txt')).status, 404);
  assert.equal((await fetch(`${base}/api/trace/clip?name=my%20tag.wav`, { method: 'POST' })).status, 403);     // no GODMIX header
  const job = b => post('/api/jobs', { kind: 'trace', album: 'T1', items: [{ id: 'one.wav' }], phrase: 'Demo', recipients: ['Jo'], ...b });
  assert.equal((await job({ recipients: [] })).status, 400);
  assert.equal((await job({ recipients: ['/:*?'] })).status, 400);                // nothing left of the name
  assert.equal((await job({ phrase: '', clips: ['nope.wav'] })).status, 400);       // no words and no real recording
  assert.equal((await job({ items: [{ id: 'other.wav' }] })).status, 400);
  assert.equal((await post('/api/trace/check?ext=exe', {})).status, 415);
  assert.equal((await up('empty.wav', '')).status, 413);                            // an empty upload isn't kept
  assert.equal((await fetch(`${base}/api/trace/clip?name=my%20tag.wav&clear=1`, { method: 'POST', headers: { 'X-God-Mix': '1' } })).status, 200);
  assert.deepEqual((await (await get('/api/trace')).json()).clips, []);
});

test('answers only requests addressed to localhost (no DNS rebinding)', async () => {
  const http = await import('node:http');
  const status = host => new Promise(ok => http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/health', headers: { host } }, r => { r.resume(); ok(r.statusCode); }));
  assert.equal(await status(`localhost:${server.address().port}`), 200);
  assert.equal(await status(`127.0.0.1:${server.address().port}`), 200);
  assert.equal(await status('attacker.example:80'), 421);
});

test('the demo export starts a job, so it needs the header like every write', async () => {
  assert.equal((await get('/api/demo-export?fmt=mp3')).status, 403);
});

test('/soon, the old "coming soon" page, sends people to the setup steps', async () => {
  const r = await fetch(base + '/soon', { redirect: 'manual' });
  assert.equal(r.status, 301);
  assert.equal(r.headers.get('location'), '/#setup');
});
