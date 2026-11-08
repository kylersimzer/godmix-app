// The online demo (server.js --demo): only the demo album, no file paths, nothing written on the server,
// MP3 copies streamed from the public folder, and the pages marked so they say "Try GODMIX". Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'godmix-demo-'));
const DATA = path.join(tmp, 'data'), STATE = path.join(tmp, 'state'), AUDIO = path.join(tmp, 'audio'), PUB = path.join(tmp, 'public');
for (const d of [DATA, STATE, AUDIO, path.join(PUB, 'audio', '01. One'), path.join(PUB, 'download')]) fs.mkdirSync(d, { recursive: true });
const flac = path.join(AUDIO, '01. One.flac');
fs.writeFileSync(flac, 'fLaC' + 'x'.repeat(100));
fs.writeFileSync(path.join(PUB, 'audio', '01. One', 'master.mp3'), 'ID3' + 'm'.repeat(50));
fs.writeFileSync(path.join(PUB, 'audio', '01. One', 'Slow.mp3'), 'ID3' + 's'.repeat(60));
fs.writeFileSync(path.join(PUB, 'download', '01. One.mp3'), 'ID3' + 'd'.repeat(70));
fs.writeFileSync(path.join(STATE, 'demo.json'), JSON.stringify({ notes: { '01. One.flac': 'private' } }));
const entry = id => ({ id, title: id === 'demo' ? '000' : id, subtitle: '', released: true, demo: id === 'demo', tracks: 1 });
fs.writeFileSync(path.join(DATA, 'albums.json'), JSON.stringify([entry('000'), entry('demo'), { ...entry('next'), released: false }]));
for (const id of ['000', 'demo'])
  fs.writeFileSync(path.join(DATA, `${id}.json`), JSON.stringify({ id, title: '000', released: true, folder: AUDIO, versions_folder: AUDIO,
    tracks: [{ name: '01. One.flac', n: 1, title: 'One', paths: { orig: flac, master: flac, versions: { Slow: flac } }, versions: [{ label: 'Slow', speed: 0.9 }] }] }));

process.env.GODMIX_DATA_DIR = DATA;
process.env.GODMIX_STATE_DIR = STATE;
process.env.GODMIX_PUBLIC_DIR = PUB;
const { createServer } = createRequire(import.meta.url)('../app/server.js');
let server, base;
before(() => new Promise(ok => { server = createServer({ demo: true }).listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; ok(); }); }));
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
const get = (p, h = {}) => fetch(base + p, { headers: h });
const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-God-Mix': '1' }, body: JSON.stringify(body) });

test('only the demo album, and health says so', async () => {
  const h = await (await get('/api/health')).json();
  assert.equal(h.mode, 'demo'); assert.deepEqual(h.albums, ['demo']);
  assert.deepEqual((await (await get('/api/albums')).json()).map(a => a.id), ['demo']);
  assert.deepEqual((await (await get('/api/albums?cards=1')).json()).map(a => a.id), ['000', 'demo']);   // the homepage's cards: released albums only, never an unreleased one
  assert.equal((await get('/data/000.json')).status, 404);
  assert.equal((await get('/audio/000/master/01.%20One.flac')).status, 404);
});

test('the data never shows where the files are', async () => {
  const text = await (await get('/data/demo.json')).text();
  assert.ok(!text.includes(tmp.replace(/\\/g, '\\\\')) && !text.includes('paths') && !text.includes('folder'), text);
  assert.equal(JSON.parse(text).tracks[0].versions[0].label, 'Slow');
});

test('streams the MP3 copies', async () => {
  const m = await get('/audio/demo/master/01.%20One.flac');
  assert.equal(m.status, 200); assert.equal(m.headers.get('content-type'), 'audio/mpeg'); assert.match(await m.text(), /^ID3m/);
  assert.match(await (await get('/audio/demo/orig/01.%20One.flac')).text(), /^ID3m/);         // a released album's original is its master
  assert.match(await (await get('/audio/demo/version/01.%20One.flac?v=Slow')).text(), /^ID3s/);
  assert.equal((await get('/audio/demo/version/01.%20One.flac?v=Nope')).status, 404);
  assert.equal((await get('/audio/demo/version/01.%20One.flac?v=..%2F..%2Fdownload%2F01.%20One')).status, 404);
  assert.equal((await get('/audio/demo/master/01.%20One.flac', { Range: 'bytes=0-2' })).status, 206);
});

test('changes nothing on the server, and keeps no state there', async () => {
  for (const [p, b] of [['/api/state?album=demo', { order: [] }], ['/api/jobs', { kind: 'make', album: 'demo' }], ['/api/folder', { path: AUDIO }],
    ['/api/open', { album: 'demo', folder: 'orig' }], ['/api/cover?album=demo', {}], ['/api/jobs', { kind: 'trace', album: 'demo' }],
    ['/api/trace/preview', { text: 'hi' }], ['/api/trace/check?ext=mp3', {}], ['/api/trace/clip?name=a.wav', {}]])
    assert.equal((await post(p, b)).status, 403, p);
  assert.deepEqual(await (await get('/api/state?album=demo')).json(), {});        // the browser keeps its own
  assert.deepEqual(await (await get('/api/jobs')).json(), []);
  assert.equal((await get('/api/trace')).status, 404);                            // no Trace Tags online
  assert.equal((await get('/api/trace/clip?name=a.wav')).status, 404);
  assert.equal(JSON.parse(fs.readFileSync(path.join(STATE, 'demo.json'), 'utf8')).notes['01. One.flac'], 'private');
});

test('the download is the prepared file, and nothing is made on request', async () => {
  const r = await (await get('/api/demo-export?fmt=mp3')).json();
  assert.equal(r.ready, true); assert.equal(r.name, '01. One.mp3');
  const f = await get(r.url);
  assert.equal(f.status, 200); assert.match(f.headers.get('content-disposition'), /attachment/);
  assert.equal((await get('/api/demo-export?fmt=flac')).status, 404);
  assert.deepEqual(await (await get('/api/jobs')).json(), []);
});

test('the pages are marked as the demo', async () => {
  for (const p of ['/', '/app']) assert.match(await (await get(p)).text(), /<html lang="en" class="demo">/, p);
});
