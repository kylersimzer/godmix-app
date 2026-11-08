// The play-through sequencer (app/web/js/sequence.mjs): gaps between songs, pausing a gap, and Hear transition.
// It's driven here with fake effects and a fake clock. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSequencer } from '../app/web/js/sequence.mjs';

const ORDER = ['a', 'b', 'c'];
function rig({ gap = 2, cont = true } = {}) {
  const log = [], timers = new Map(), opt = { gap, cont };
  let cur = 'a', id = 0, note = null;
  const seq = createSequencer({
    gap: () => opt.gap, cont: () => opt.cont, next: () => ORDER[ORDER.indexOf(cur) + 1] ?? null,
    play: n => { seq.reset(); cur = n; log.push(`play ${n}`); }, stopAt: s => log.push(`stop at ${s}`),
    note: t => { note = t; }, schedule: (fn, ms) => { timers.set(++id, { fn, ms }); return id; }, cancel: k => timers.delete(k),
  });
  const tick = () => { const [[k, t]] = [...timers]; timers.delete(k); t.fn(); return t.ms; };
  return { seq, log, timers, opt, tick, note: () => note, cur: () => cur };
}

test('a song ending with Play through on waits the gap, then plays the next', () => {
  const r = rig();
  r.seq.ended();
  assert.deepEqual(r.seq.state, { name: 'gap', next: 'b', label: 'next: b' });
  assert.equal(r.seq.waiting(), true);
  assert.equal(r.note(), 'next: b');
  assert.equal(r.tick(), 2000);
  assert.deepEqual(r.log, ['play b']);
  assert.deepEqual(r.seq.state, { name: 'idle' });
  assert.equal(r.note(), null);
});

test('with Play through off, or at the last song, a song ending just stops', () => {
  const off = rig({ cont: false });
  off.seq.ended();
  assert.equal(off.seq.state.name, 'idle'); assert.equal(off.timers.size, 0);
  const last = rig();
  last.seq.ended(); last.tick(); last.seq.ended(); last.tick();       // a → b → c
  last.seq.ended();
  assert.equal(last.cur(), 'c'); assert.equal(last.seq.state.name, 'idle');
});

test('a 0 s gap goes straight on, with no timer', () => {
  const r = rig({ gap: 0 });
  assert.equal(r.seq.autoNext(), 'b');
  r.seq.ended();
  assert.deepEqual(r.log, ['play b']); assert.equal(r.timers.size, 0);
});

test('pausing during a gap holds it; playing goes straight on to the next song', () => {
  const r = rig();
  r.seq.ended();
  assert.equal(r.seq.toggle(), true);
  assert.deepEqual(r.seq.state, { name: 'held', next: 'b' });
  assert.equal(r.timers.size, 0, 'the countdown stopped');
  assert.equal(r.seq.waiting(), false); assert.equal(r.seq.between(), true);
  assert.match(r.note(), /paused/);
  assert.equal(r.seq.toggle(), true);
  assert.deepEqual(r.log, ['play b']); assert.equal(r.seq.state.name, 'idle');
});

test('outside a gap, pause and play are the engine\'s to handle', () => {
  const r = rig();
  assert.equal(r.seq.toggle(), false); assert.equal(r.seq.pause(), false); assert.equal(r.seq.resume(), false);
});

test('starting a song by hand drops whatever was pending', () => {
  const r = rig();
  r.seq.ended();
  r.seq.reset();
  assert.equal(r.seq.state.name, 'idle'); assert.equal(r.timers.size, 0); assert.equal(r.note(), null);
});

test('Hear transition: the tail, the gap, the head and its stop point', () => {
  const r = rig({ cont: false });                                     // works with Play through off too
  r.seq.preview('b', 10);
  assert.deepEqual(r.seq.state, { name: 'tail', next: 'b', len: 10 });
  assert.equal(r.seq.upcoming(), 'b'); assert.equal(r.seq.autoNext(), 'b');
  r.seq.ended();
  assert.deepEqual(r.seq.state, { name: 'gap', next: 'b', len: 10, label: 'gap 2 s…' });
  r.tick();
  assert.deepEqual(r.log, ['play b', 'stop at 10']);
  assert.deepEqual(r.seq.state, { name: 'head' });
  assert.equal(r.note(), 'transition preview');
  assert.equal(r.seq.autoNext(), null, 'the head never runs on into another song');
  r.seq.previewEnded();
  assert.equal(r.seq.state.name, 'idle'); assert.equal(r.note(), null);
});

test('a transition preview paused in its gap resumes into the head', () => {
  const r = rig();
  r.seq.preview('b', 5); r.seq.ended(); r.seq.pause();
  assert.deepEqual(r.seq.state, { name: 'held', next: 'b', len: 5 });
  r.seq.resume();
  assert.deepEqual(r.log, ['play b', 'stop at 5']); assert.equal(r.seq.state.name, 'head');
});

test('a head that reaches the end of its song stops instead of playing on', () => {
  const r = rig();
  r.seq.preview('b', 30); r.seq.ended(); r.tick();
  r.seq.ended();
  assert.equal(r.seq.state.name, 'idle'); assert.equal(r.timers.size, 0); assert.deepEqual(r.log, ['play b', 'stop at 30']);
});

test('if the next song can\'t start, the preview stops there (no stop point on the old song)', () => {
  const log = [];
  const seq = createSequencer({ gap: () => 0, cont: () => false, next: () => null, play: () => false, stopAt: s => log.push(s), note: () => {} });
  seq.preview('gone', 10); seq.ended();
  assert.deepEqual(log, []); assert.equal(seq.state.name, 'idle');
});

test('state is plain data, safe to show or log', () => {
  const r = rig();
  r.seq.ended();
  assert.deepEqual(JSON.parse(JSON.stringify(r.seq.state)), r.seq.state);
});
