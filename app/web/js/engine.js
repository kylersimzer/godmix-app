// The audio engine: a pair of <audio> elements through Web Audio, plus a standby pair that preloads the
// next song so it starts instantly (gapless when the gap is 0).
//
//   No version picked:  A = the original mix, B = the album master. They share a clock, so both play and
//                       A is kept locked to B; switching sides is a 12 ms gain crossfade.
//   A version picked:   A = the album master, B = the version. B runs at the version's speed, so the two
//                       are on different clocks: only the side you hear plays. Switching sides puts the
//                       other file at the same moment in the song and starts it, then the silent one is
//                       paused. (Keeping both running and re-seeking the hidden one stutters.)
//
// Loops, marks and stop points are kept in song time (the master's clock), so they stay put when you
// switch versions. Listening modes: stereo, mono (fold-down), phone (mono, 350 Hz–5 kHz). A meter reads
// the output peaks. `setBlend` moves a crossfade position for sliders; `setSide` is all one or the other.
import { clamp } from './util.js';

export function createEngine({ urlFor, track, onEnded = () => {}, onChange = () => {} }) {
  const mk = () => { const a = new Audio(); a.preload = 'auto'; return a; };
  const pairs = [{ A: mk(), B: mk(), key: null }, { A: mk(), B: mk(), key: null }];
  let act = 0;
  const P = () => pairs[act], S = () => pairs[1 - act];
  const E = { cur: null, ver: null, side: 'B', blend: null, mode: 'stereo', match: false, volume: 0.9, loop: null, stopAt: null, wantPlay: false };
  let ctx = null, mix, mono, hp, lp, out, split, anL, anR, parkTimer = null;
  const bufL = new Float32Array(2048), bufR = new Float32Array(2048);
  let peaks = [-Infinity, -Infinity];

  function ensureCtx() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    mix = ctx.createGain(); out = ctx.createGain();
    for (const p of pairs) {
      p.gA = ctx.createGain(); p.gB = ctx.createGain(); p.gA.gain.value = p.gB.gain.value = 0;
      ctx.createMediaElementSource(p.A).connect(p.gA).connect(mix);
      ctx.createMediaElementSource(p.B).connect(p.gB).connect(mix);
    }
    mono = ctx.createGain(); mono.channelCount = 1; mono.channelCountMode = 'explicit'; mono.channelInterpretation = 'speakers';
    hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 350; hp.Q.value = 0.7;
    lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 5000; lp.Q.value = 0.7;
    split = ctx.createChannelSplitter(2); anL = ctx.createAnalyser(); anR = ctx.createAnalyser();
    anL.fftSize = anR.fftSize = 2048;
    out.connect(ctx.destination); out.connect(split); split.connect(anL, 0); split.connect(anR, 1);
    route(); gains(true); out.gain.value = E.volume;
  }
  function route() {
    if (!ctx) return;
    [mix, mono, hp, lp].forEach(n => n.disconnect());
    if (E.mode === 'stereo') mix.connect(out);
    else if (E.mode === 'mono') mix.connect(mono).connect(out);
    else mix.connect(mono).connect(hp).connect(lp).connect(out);
  }
  // B is turned down to A's loudness when matching: master vs original, or version vs master
  function matchGain() {
    const t = track(E.cur);
    if (!t || !E.match) return 1;
    return Math.pow(10, -(E.ver ? E.ver.I - t.after.I : t.after.I - t.before.I) / 20);
  }
  const blendNow = () => E.blend ?? (E.side === 'A' ? 0 : 1);        // 0 = all A, 1 = all B
  function gains(now) {
    if (!ctx) return;
    const tc = now ? 0.001 : 0.012, t0 = ctx.currentTime, p = P(), s = S(), x = blendNow();
    p.gA.gain.setTargetAtTime(1 - x, t0, tc);
    p.gB.gain.setTargetAtTime(x * matchGain(), t0, tc);
    s.gA.gain.setTargetAtTime(0, t0, 0.001); s.gB.gain.setTargetAtTime(0, t0, 0.001);
  }

  // ── clocks ──
  const speed = () => (E.ver ? E.ver.speed : 1);
  const dur = () => (E.ver ? E.ver.dur : track(E.cur)?.dur || 0);                    // on B's clock
  const aTime = tb => (E.ver ? Math.min(tb * E.ver.speed, track(E.cur)?.dur ?? Infinity) : tb);
  const twoClocks = () => !!E.ver && E.ver.speed !== 1;
  const clockEl = () => (twoClocks() && E.side === 'A' ? P().A : P().B);           // the element you hear
  const bTime = () => (twoClocks() && E.side === 'A' ? (P().A.currentTime || 0) / E.ver.speed : P().B.currentTime || 0);
  const songTime = () => aTime(bTime());
  const keyOf = (name, version) => `${name}\u0000${version?.label || ''}`;
  const srcs = (name, version) => [version ? urlFor('master', name) : urlFor('orig', name), version ? urlFor('version', name, version.label) : urlFor('master', name)];

  // With two clocks, start the side that's becoming audible at the same moment in the song, and park the
  // other once it's silent. With one clock both keep running, so there's nothing to do.
  function syncSides(from) {
    clearTimeout(parkTimer);
    if (!twoClocks()) return;
    const p = P(), toA = E.side === 'A', on = toA ? p.A : p.B, off = toA ? p.B : p.A;
    if (from === E.side) return;
    const tb = from === 'A' ? (p.A.currentTime || 0) / E.ver.speed : p.B.currentTime || 0;
    if (toA) on.currentTime = aTime(tb); else on.currentTime = tb;
    if (E.wantPlay) { on.play().catch(() => {}); parkTimer = setTimeout(() => { if (clockEl() !== off) off.pause(); }, 80); }
  }

  // Get a song ready on the standby pair, so a later load() of it starts at once.
  E.preload = (name, version = null) => {
    if (!name || !track(name)) return;
    const k = keyOf(name, version), s = S();
    if (s.key === k || P().key === k) return;
    const [a, b] = srcs(name, version);
    s.A.src = a; s.B.src = b; s.key = k;
    s.A.load(); s.B.load();
  };

  function load(name, { at = 0, play = false, version = null } = {}) {
    const k = keyOf(name, version);
    clearTimeout(parkTimer);
    E.cur = name; E.ver = version; E.stopAt = null; E.wantPlay = false;
    if (S().key === k) {                         // already buffered on standby: swap pairs
      const old = P(); old.A.pause(); old.B.pause();
      act = 1 - act;
    } else if (P().key !== k) {
      const [a, b] = srcs(name, version), p = P();
      p.A.src = a; p.B.src = b; p.key = k;
    }
    const p = P();
    p.B.currentTime = at; p.A.currentTime = aTime(at);
    gains(true);
    onChange('load');
    if (play) E.play();
  }
  E.load = load;
  E.play = (retry = true) => {
    if (!E.cur) return;
    ensureCtx(); ctx.resume(); gains(true); E.wantPlay = true;
    const p = P(), els = twoClocks() ? [clockEl()] : [p.B, p.A];
    if (twoClocks()) (clockEl() === p.A ? p.B : p.A).pause();
    Promise.all(els.map(el => el.play())).catch(() => { if (retry) els[0].addEventListener('canplay', () => E.play(false), { once: true }); });
  };
  E.pause = () => { clearTimeout(parkTimer); E.wantPlay = false; P().A.pause(); P().B.pause(); };
  E.paused = () => clockEl().paused;
  E.toggle = () => (E.paused() ? E.play() : E.pause());
  E.seek = tb => { tb = clamp(tb, 0, Math.max(0, dur() - 0.05)); P().B.currentTime = tb; P().A.currentTime = aTime(tb); onChange('seek'); };
  E.seekSong = ts => E.seek(ts / speed());
  E.nudge = s => E.seek(bTime() + s);
  E.remaining = () => (E.cur ? dur() - bTime() : Infinity);
  E.setSide = s => { const from = E.side; E.side = s; E.blend = null; syncSides(from); gains(); onChange('side'); };
  E.setBlend = x => { const from = E.side; E.blend = clamp(x, 0, 1); E.side = x < 0.5 ? 'A' : 'B'; syncSides(from); gains(); onChange('side'); };
  E.setMode = m => { E.mode = m; route(); onChange('mode'); };
  E.setMatch = v => { E.match = v; gains(); onChange('match'); };
  E.setVolume = v => { E.volume = clamp(v, 0, 1); if (out) out.gain.setTargetAtTime(E.volume, ctx.currentTime, 0.01); onChange('volume'); };
  E.setLoop = (a, b) => { E.loop = a == null ? null : { a: Math.min(a, b), b: Math.max(a, b), on: true }; onChange('loop'); };
  E.toggleLoop = () => { if (E.loop) { E.loop.on = !E.loop.on; onChange('loop'); } };
  E.unload = () => {
    E.pause();
    for (const p of pairs) { for (const el of [p.A, p.B]) { el.removeAttribute('src'); el.load(); } p.key = null; }
    E.cur = null; E.ver = null; E.loop = null; E.blend = null; onChange('load');
  };
  Object.assign(E, { dur, bTime, songTime, speed, aTime });
  // what the elements are doing, for debugging
  E.debug = () => { const p = P(), d = el => ({ paused: el.paused, t: +el.currentTime.toFixed(2), ready: el.readyState, err: el.error?.code || null, src: (el.getAttribute('src') || '').slice(-50) }); return { side: E.side, blend: E.blend, cur: E.cur, ver: E.ver?.label || null, wantPlay: E.wantPlay, twoClocks: twoClocks(), clock: clockEl() === p.A ? 'A' : 'B', A: d(p.A), B: d(p.B), ctx: ctx?.state || null }; };

  // output peak level in dBFS per channel, with a slow fall like a meter's ballistics
  E.meter = () => {
    if (!ctx || E.paused()) { peaks = peaks.map(p => Math.max(-60, p - 1.5)); return peaks; }
    anL.getFloatTimeDomainData(bufL); anR.getFloatTimeDomainData(bufR);
    const pk = b => { let m = 0; for (let i = 0; i < b.length; i++) { const v = Math.abs(b[i]); if (v > m) m = v; } return 20 * Math.log10(m + 1e-9); };
    const now = E.mode === 'stereo' ? [pk(bufL), pk(bufR)] : [pk(bufL), pk(bufL)];
    peaks = peaks.map((p, i) => (now[i] > p ? now[i] : Math.max(now[i], p - 0.8)));
    return peaks;
  };

  // one clock: keep A locked to B; always: loops and preview stops
  setInterval(() => {
    if (!E.cur || E.paused()) return;
    const p = P();
    if (!twoClocks()) { const want = p.B.currentTime || 0; if (Math.abs(p.A.currentTime - want) > 0.06 && want < (p.A.duration || Infinity) - 0.1) p.A.currentTime = want; }
    if (E.loop?.on && songTime() >= E.loop.b) E.seekSong(E.loop.a);
    if (E.stopAt != null && bTime() >= E.stopAt) { E.stopAt = null; E.pause(); onChange('preview-end'); }
  }, 20);

  // events count only from the element you're hearing, on the pair that's playing
  for (const p of pairs) for (const el of [p.A, p.B]) {
    const live = () => p === P() && el === clockEl();
    el.addEventListener('play', () => live() && onChange('play'));
    el.addEventListener('pause', () => { if (!live()) return; if (el === p.B) p.A.pause(); else p.B.pause(); onChange('pause'); });
    el.addEventListener('ended', () => { if (!live()) return; E.wantPlay = false; p.A.pause(); p.B.pause(); onEnded(); });
    el.addEventListener('error', () => { if (live() && el.getAttribute('src')) onChange('error'); });
  }
  return E;
}
