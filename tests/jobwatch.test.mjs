// The app's job watch (app/web/js/jobwatch.mjs): each finish reported once, quick jobs not missed, and jobs
// lost to a server restart reported as gone. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJobWatch, isLive } from '../app/web/js/jobwatch.mjs';

const job = (id, status) => ({ id, status, label: id });
const now = changes => changes.map(c => `${c.job.id}:${c.was}→${c.now}`);

test('reports each change of status once', () => {
  const w = createJobWatch();
  assert.deepEqual(w.update([job('a', 'queued')]), []);
  assert.deepEqual(now(w.update([job('a', 'running')])), ['a:queued→running']);
  assert.deepEqual(now(w.update([job('a', 'done')])), ['a:running→done']);
  assert.deepEqual(w.update([job('a', 'done')]), []);
});

test('a job this app started is reported even if it finished before the first look', () => {
  const w = createJobWatch();
  w.saw(job('quick', 'queued'));
  assert.deepEqual(now(w.update([job('quick', 'done')])), ['quick:queued→done']);
});

test('jobs already finished when first seen (another tab, before a reload) are not reported', () => {
  const w = createJobWatch();
  assert.deepEqual(w.update([job('old', 'done'), job('older', 'error')]), []);
});

test('a live job missing from the list ended with the server: gone', () => {
  const w = createJobWatch();
  w.update([job('a', 'running'), job('b', 'done')]);
  assert.equal(w.live(), true);
  const c = w.update([]);
  assert.deepEqual(now(c), ['a:running→gone']);
  assert.equal(c[0].job.status, 'gone');
  assert.equal(w.live(), false);
  assert.deepEqual(w.update([]), [], 'reported once');
});

test('a job just started is not "gone" because a list from before it existed lacks it', () => {
  const w = createJobWatch();
  w.update([job('a', 'running')]);
  w.saw(job('b', 'queued'));
  assert.deepEqual(w.update([job('a', 'running')]), [], 'a reply fetched before b was queued');
  assert.deepEqual(now(w.update([job('a', 'running'), job('b', 'done')])), ['b:queued→done']);
});

test('isLive: queued and running only', () => {
  assert.deepEqual(['queued', 'running', 'done', 'error', 'gone'].map(s => isLive({ status: s })), [true, true, false, false, false]);
});
