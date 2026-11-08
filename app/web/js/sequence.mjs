// The play-through sequencer: what happens when a song ends. It's one explicit state machine, so the player,
// the gap note, the keyboard and the media keys all agree on what comes next.
//
//   idle  ── a song ends, Play through on ──────────────► gap ── the gap is up ──► the next song plays ──► idle
//   tail  ── (Hear transition: a song's last seconds) end ► gap ── the gap is up ──► head ── its stop point ──► idle
//   gap   ── pause ──► held ── play ──► straight on to what was next (no second wait)
//   any   ── a song started by hand, Next, another album ──► idle   (reset)
//
// States, as `state` reports them (all plain data):
//   {name: 'idle'}                       nothing pending: a song ending just stops
//   {name: 'tail', next, len}            playing the end of a song for Hear transition; `next` follows after the gap
//   {name: 'gap', next, len?, label}     silence between songs, counting down the album's gap
//   {name: 'held', next, len?}           the gap was paused; play goes on to `next`
//   {name: 'head'}                       playing the first `len` seconds of the transition's second song
// `len` on gap or held means the next song is the second half of a transition preview, stopped after `len` s.
//
// The app supplies every effect, and nothing here touches the page, so tests/sequence.test.mjs drives it directly.
export function createSequencer({ gap, cont, next, title = n => n, play, stopAt, note, changed = () => {}, schedule = setTimeout, cancel = clearTimeout }) {
  let s = { name: 'idle' }, timer = null;

  const to = (state, text = null) => { cancel(timer); timer = null; s = state; note(text); changed(); };
  const step = st => (st.len == null ? { next: st.next } : { next: st.next, len: st.len });

  // start what was pending: the next song, or the second half of a transition preview. play() returns false when
  // the song can't start (gone from the album since): then nothing more happens.
  function go(st) {
    to({ name: 'idle' });
    if (play(st.next) === false) return;
    if (st.len != null) { stopAt(st.len); to({ name: 'head' }, 'transition preview'); }
  }
  // wait the album's gap, then go (no gap: go now)
  function wait(st, label) {
    const g = gap();
    if (!(g > 0)) return go(st);
    to({ name: 'gap', ...step(st), label }, label);
    timer = schedule(() => { timer = null; go(st); }, g * 1000);
  }

  return {
    get state() { return { ...s }; },
    // a song finished (the browser's 'ended', or just before it with a 0 s gap)
    ended() {
      if (s.name === 'tail') return wait(step(s), `gap ${gap()} s…`);
      if (s.name === 'head') return to({ name: 'idle' });
      if (s.name === 'idle') { const n = cont() ? next() : null; if (n) return wait({ next: n }, `next: ${title(n)}`); }
      changed();
    },
    // Hear transition: the app has started the first song's last seconds; `n` follows, for `len` s
    preview(n, len) { to({ name: 'tail', next: n, len }, 'transition preview'); },
    // the head's stop point passed (the engine's 'preview-end')
    previewEnded() { if (s.name === 'head') to({ name: 'idle' }); },
    // anything started by hand replaces what was pending
    reset() { if (s.name !== 'idle') to({ name: 'idle' }); },
    // Space and the media keys: true when the sequencer handled it (between songs), so the engine shouldn't
    pause() { if (s.name !== 'gap') return false; to({ name: 'held', ...step(s) }, `paused · next: ${title(s.next)}`); return true; },
    resume() { if (s.name !== 'gap' && s.name !== 'held') return false; go(step(s)); return true; },
    toggle() { return s.name === 'gap' ? this.pause() : this.resume(); },
    // counting down a gap counts as playing (the player shows Pause, the waveform keeps drawing)
    waiting: () => s.name === 'gap',
    // between two songs: the current song has ended and another is pending
    between: () => s.name === 'gap' || s.name === 'held',
    // the song to keep buffered on the engine's standby pair, when it isn't simply the next in the running order
    upcoming: () => (s.name === 'tail' || s.name === 'gap' || s.name === 'held' ? s.next : null),
    // the song that a 0 s gap starts the moment this one ends, or null
    autoNext: () => (s.name === 'tail' ? s.next : s.name === 'idle' && cont() ? next() : null),
  };
}
