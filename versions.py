"""Alternate versions (Slowed + Reverb, Sped Up, Other Room, Bass Boosted, Max Bass Boost), for any album in albums.json.
Recipes are shared (versions_cfg.json 'recipes'); which songs get which versions, and each song's own
settings, are per album ('albums' -> <id> -> 'tracks' / 'overrides', keyed by title). The demo's shipped
settings are in versions_cfg.json; everything you change or add is saved to local/versions_cfg.json, which is
merged over it on load, so the files in the repo never change under you.

Released albums are read-only: versions are made from the album file, any static burst at the very start
is cut in memory only, and the level follows that song's own released master. An album still being mastered
("masters" set) uses its cleaned originals, with the level from render_cfg.json (local/render_cfg.json over it).
Output: <album folder>/Versions/24-bit 48kHz/<#>. <Title> (<Version>) 24-bit 48kHz.wav  (+ 16-bit 44.1kHz)
Usage: python versions.py [--album 000] [--only "Slowed + Reverb"] [track # or title ...]"""
import sys, os, re, glob, json
from fractions import Fraction
import numpy as np
import soundfile as sf
from scipy import signal
from pedalboard import Pedalboard, Reverb, LowpassFilter, HighShelfFilter
import mlib
import edge_clean
import albums
from sweep import render_to

HERE = os.path.dirname(os.path.abspath(__file__))
CFG = albums.layered("render_cfg.json")
VCFG_PATH = os.path.join(HERE, "versions_cfg.json")
VCFG_LOCAL = albums.local_path("versions_cfg.json")
VCFG = json.load(open(VCFG_PATH, encoding="utf-8"))
_SHIPPED = json.loads(json.dumps(VCFG))          # as the repo has it, to save only what differs
if os.path.exists(VCFG_LOCAL):
    VCFG.setdefault("albums", {}).update(json.load(open(VCFG_LOCAL, encoding="utf-8")).get("albums", {}))
REPORT = os.path.join(HERE, "versions_report.json")


def save_vcfg():
    """Every album section that differs from the repo's goes to local/versions_cfg.json. versions_cfg.json is
    rewritten only when the shared recipes themselves change."""
    alb = VCFG.get("albums", {})
    if VCFG.get("recipes") != _SHIPPED.get("recipes"):
        json.dump(dict(_SHIPPED, recipes=VCFG["recipes"]), open(VCFG_PATH, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
    mine = {k: v for k, v in alb.items() if v != _SHIPPED.get("albums", {}).get(k)}
    if mine or os.path.exists(VCFG_LOCAL):
        os.makedirs(os.path.dirname(VCFG_LOCAL), exist_ok=True)
        json.dump({"albums": mine}, open(VCFG_LOCAL, "w", encoding="utf-8"), indent=2, ensure_ascii=False)


def _merge(base, over):
    out = dict(base)
    for k, v in over.items():
        out[k] = _merge(base[k], v) if isinstance(v, dict) and isinstance(base.get(k), dict) else v
    return out


def album_cfg(aid):
    return VCFG.setdefault("albums", {}).setdefault(aid, {"tracks": {}, "overrides": {}})


def recipe_for(aid, title, version):
    """The shared recipe, with this song's own settings layered on top."""
    return _merge(VCFG["recipes"][version], album_cfg(aid).get("overrides", {}).get(title, {}).get(version, {}))


def version_path(a, t, version, kind="hi"):
    """-> <album>/Versions/24-bit 48kHz/<#>. <Title> (<Version>) 24-bit 48kHz.wav"""
    label = mlib.MASTER_LABELS[kind]
    return os.path.join(a["versions_dir"], label, f"{t['stem']} ({version}) {label}.wav")


def vinyl_speed(x, speed):
    """Play faster/slower like a turntable: tempo and pitch move together (resampling)."""
    if speed == 1:
        return x
    f = Fraction(speed).limit_denominator(200)
    return signal.resample_poly(x, f.denominator, f.numerator, axis=0)


def duck_gain(x, fs, duck_db, release_ms=250.0, attack_ms=15.0):
    """Per-sample gain for the reverb return that dips by up to duck_db while the dry song is loud,
    and lets the reverb bloom in the gaps (keeps vocals and drums clear)."""
    if not duck_db:
        return np.ones(len(x))
    blk = int(fs * 0.01)
    n = len(x) // blk
    m = x[: n * blk].mean(axis=1).reshape(n, blk)
    lvl = 10 * np.log10(np.mean(m ** 2, axis=1) + 1e-12)          # dB per 10 ms
    top = np.percentile(lvl[lvl > -70], 95) if (lvl > -70).any() else 0
    want = np.clip((lvl - (top - 15)) / 12, 0, 1) * duck_db      # full duck within ~3 dB of the loudest parts
    a_att, a_rel = np.exp(-10 / attack_ms), np.exp(-10 / release_ms)
    env, g = 0.0, np.empty(n)
    for i, w in enumerate(want):                                   # fast attack, slow release
        env = a_att * env + (1 - a_att) * w if w > env else a_rel * env + (1 - a_rel) * w
        g[i] = env
    g = np.interp(np.arange(len(x)), np.arange(n) * blk + blk / 2, g)
    return 10 ** (-g / 20)


def deess(x, fs, d):
    """De-esser: split off the top band (zero-phase, so the two halves add back perfectly), and turn that
    band down only in the moments it spikes above its usual level - "s", "t", "ch" and harsh hats."""
    sos = signal.butter(4, d["from_hz"], "highpass", fs=fs, output="sos")
    high = signal.sosfiltfilt(sos, x, axis=0)
    low = x - high
    blk = max(1, int(fs * 0.002))                              # 2 ms detection
    n = len(x) // blk
    lvl = 10 * np.log10(np.mean(high[: n * blk].mean(axis=1).reshape(n, blk) ** 2, axis=1) + 1e-14)
    live = lvl > lvl.max() - 60
    thr = np.percentile(lvl[live], d.get("above_percentile", 85))
    want = np.clip((lvl - thr) * (1 - 1 / d.get("ratio", 3.0)), 0, d.get("max_db", 6.0))
    a_att, a_rel = np.exp(-2 / d.get("attack_ms", 1.0)), np.exp(-2 / d.get("release_ms", 60.0))
    env, g = 0.0, np.empty(n)
    for i, w in enumerate(want):
        env = a_att * env + (1 - a_att) * w if w > env else a_rel * env + (1 - a_rel) * w
        g[i] = env
    gain = 10 ** (-np.interp(np.arange(len(x)), np.arange(n) * blk + blk / 2, g) / 20)
    return low + high * gain[:, None]


def high_shelf(x, fs, s):
    board = Pedalboard([HighShelfFilter(cutoff_frequency_hz=s["hz"], gain_db=s["db"], q=s.get("q", 0.7))])
    return board(x.T.astype(np.float32), fs).T.astype(np.float64)


def reverb_send(x, fs, r):
    """Reverb on a send, like a mixing desk: filter the send (no sub, no fizz), pre-delay it so the
    dry attack stays in front, then duck the return under the dry signal. Returns (mix, reverb return)."""
    send = x
    if r.get("send_highpass_hz"):
        send = signal.sosfilt(signal.butter(2, r["send_highpass_hz"], "highpass", fs=fs, output="sos"), send, axis=0)
    if r.get("send_lowpass_hz"):
        send = signal.sosfilt(signal.butter(2, r["send_lowpass_hz"], "lowpass", fs=fs, output="sos"), send, axis=0)
    pre = int(fs * r.get("predelay_ms", 0) / 1000)
    if pre:
        send = np.concatenate([np.zeros((pre, send.shape[1])), send[:-pre]])
    rv = Reverb(room_size=r["room_size"], damping=r["damping"], width=r["width"], wet_level=1.0, dry_level=0.0)
    wet = rv(send.T.astype(np.float32), fs).T.astype(np.float64)
    wet *= r["wet"] * duck_gain(x, fs, r.get("duck_db", 0), r.get("duck_release_ms", 250.0))[:, None]
    return x + wet, wet


def _rms(a):
    return float(np.sqrt(np.mean(a ** 2))) + 1e-12


def split_low(x, fs, hz):
    """Zero-phase crossover: (low, high) with low + high == x exactly."""
    low = signal.sosfiltfilt(signal.butter(4, hz, "lowpass", fs=fs, output="sos"), x, axis=0)
    return low, x - low


def saturate(x, drive):
    """tanh saturation scaled to the signal's own peaks, so `drive` means the same on any level."""
    ref = np.percentile(np.abs(x), 99.5) + 1e-9
    return np.tanh(drive * x / ref) / np.tanh(drive) * ref


def follow(x, fs, attack_ms=5.0, release_ms=120.0):
    """RMS envelope (5 ms blocks), fast attack and slow release."""
    blk = max(1, int(fs * 0.005))
    n = len(x) // blk
    lvl = np.sqrt(np.mean(x[: n * blk].reshape(n, blk) ** 2, axis=1) + 1e-12)
    a, r = np.exp(-5 / attack_ms), np.exp(-5 / release_ms)
    e, out = 0.0, np.empty(n)
    for i, v in enumerate(lvl):
        e = a * e + (1 - a) * v if v > e else r * e + (1 - r) * v
        out[i] = e
    return np.interp(np.arange(len(x)), np.arange(n) * blk + blk / 2, out)


def bass_boost(x, fs, b):
    """Bass Boosted / Max Bass Boost, from the finished stereo song (no stems):
    - split at split_hz; the lows go mono and get sub_db more below sub_hz
    - the lows are saturated (drive, blended by sat_mix, filtered at sat_lp_hz) so the bass is heard on phones
    - the boost is set per song: the lows end up low_ratio_db over the rest (3..9 dB of boost), so songs that
      already have big lows get less and thin ones more
    - the rest of the song dips by up to duck_db as the bass hits; mix_sat saturates the whole song a little.
    Returns (song, boost in dB)."""
    low, high = split_low(x, fs, b["split_hz"])
    boost = float(np.clip(b["low_ratio_db"] - 20 * np.log10(_rms(low) / _rms(high)), *b.get("boost_range_db", (3.0, 9.0))))
    low = np.repeat(low.mean(axis=1, keepdims=True), 2, axis=1)
    sub, _ = split_low(low, fs, b.get("sub_hz", 60))
    low = low + sub * (10 ** (b.get("sub_db", 0.0) / 20) - 1)
    sat = saturate(low, b["drive"])
    sat = signal.sosfiltfilt(signal.butter(2, b["sat_lp_hz"], "lowpass", fs=fs, output="sos"), sat, axis=0)
    low = (1 - b["sat_mix"]) * low + b["sat_mix"] * sat * (_rms(low) / _rms(sat))
    low *= 10 ** (boost / 20)
    if b.get("duck_db"):
        e = follow(low.mean(axis=1), fs)
        e = np.clip(e / (np.percentile(e, 98) + 1e-12), 0, 1)
        high = high * (10 ** (-b["duck_db"] * e / 20))[:, None]
    y = low + high
    if b.get("mix_sat"):
        y = (1 - b["mix_sat"]) * y + b["mix_sat"] * saturate(y, 3.0)
    return y, boost


def make_version(x, fs, recipe):
    y = vinyl_speed(x, recipe.get("speed", 1.0))
    # tone-shaping on the dry song, before any reverb, so the reverb doesn't spread the harshness
    if recipe.get("deess"):
        y = deess(y, fs, recipe["deess"])
    if recipe.get("high_shelf"):
        y = high_shelf(y, fs, recipe["high_shelf"])
    if recipe.get("mono"):
        y = np.repeat(y.mean(axis=1, keepdims=True), 2, axis=1)
    if recipe.get("lowpass_hz"):
        board = Pedalboard([LowpassFilter(cutoff_frequency_hz=recipe["lowpass_hz"]) for _ in range(recipe.get("lowpass_passes", 1))])
        y = board(y.T.astype(np.float32), fs).T.astype(np.float64)
    if recipe.get("bass"):
        y, _ = bass_boost(y, fs, recipe["bass"])
    if recipe.get("tail_s"):
        y = np.concatenate([y, np.zeros((int(recipe["tail_s"] * fs), y.shape[1]))])
    if recipe.get("reverb"):
        y, _ = reverb_send(y, fs, recipe["reverb"])
    if recipe.get("tail_s"):
        # trim the padding back to where the reverb tail has died away (-70 dBFS)
        a = np.abs(y).max(axis=1)
        last = np.nonzero(a > a.max() * 10 ** (-70 / 20))[0][-1]
        y = y[: last + int(0.05 * fs)]
    return y


def load_source(a, t):
    """The audio a version is made from. Released albums: the album file, with any static burst at the start
    removed in memory (the file itself is never changed). An album being mastered: its already-cleaned original."""
    x, fs = mlib.load(t["src"])
    note = ""
    if a["released"]:
        plan = edge_clean.analyze(x, fs, 1.0)
        if plan["cut_samples"] or plan["fade_in_ms"] or plan["fade_out_ms"]:
            x = edge_clean.apply(x, fs, plan)
        note = " | ".join(plan["reasons"]) if plan["action"] != "none" else ""
    return x, fs, note


def job(args):
    aid, tid, version = args
    a = albums.album(aid)
    t = albums.track(a, tid)
    recipe = recipe_for(aid, t["title"], version)
    x, fs, note = load_source(a, t)
    y = mlib.highpass(make_version(x, fs, recipe), fs, recipe.get("highpass_hz", 20.0))
    if recipe.get("target_lufs") is not None:
        # a fixed level (the bass versions are meant to be louder than any album)
        target = recipe["target_lufs"]
    elif a["released"]:
        # follow this song's own released level (its loud sections), plus the version's offset
        mx, _ = mlib.load(t["master"])
        target = mlib.loud_section(mlib.short_term(mx, fs, hop=0.5)) + recipe.get("target_offset", 0.0)
    else:
        target = CFG["target"] + CFG.get("offsets", {}).get(t["title"], 0.0) + recipe.get("target_offset", 0.0)
    chain = dict(CFG["chain"], **{k: recipe[k] for k in ("clip_db",) if k in recipe})
    y, info, gain = render_to(y, fs, target, ceiling_db=CFG["ceiling"], **chain)
    y = mlib.edge_fades(y, fs, out_ms=30.0 if recipe.get("tail_s") else 5.0)
    hi, cd = version_path(a, t, version, "hi"), version_path(a, t, version, "cd")
    sf.write(hi, mlib.tpdf_dither_quantize(y, 24), fs, subtype="PCM_24")
    y44 = signal.resample_poly(y, 147, 160, axis=0)
    y44, _ = mlib.limiter(y44, 44100, CFG["ceiling"] - 0.05, 1.0, 40.0)
    y44 = mlib.edge_fades(y44, 44100)
    sf.write(cd, mlib.tpdf_dither_quantize(y44, 16), 44100, subtype="PCM_16")
    m = mlib.measure(sf.read(hi, always_2d=True)[0], fs)
    return dict(album=aid, track=t["id"], title=t["title"], version=version, file=os.path.basename(hi),
                speed=recipe.get("speed", 1.0), dur=len(y) / fs, target=target, I=m["I"], loud=m["loud"], TP=m["TP"],
                gr_mean=float(info["gr1"].mean()), gr_p95=float(np.percentile(info["gr1"], 95)), source_note=note)


def load_report():
    rows = json.load(open(REPORT)) if os.path.exists(REPORT) else []
    return {f"{r.get('album', albums.default_id())}/{r['file']}": dict(r, album=r.get("album", albums.default_id())) for r in rows}


if __name__ == "__main__":
    from concurrent.futures import ProcessPoolExecutor
    args, only, aid = sys.argv[1:], None, albums.default_id()
    for flag in ("--only", "--album"):
        if flag in args:
            i = args.index(flag)
            if flag == "--only": only = args[i + 1]
            else: aid = args[i + 1]
            args = args[:i] + args[i + 2:]
    a = albums.album(aid)
    cfg = album_cfg(aid)
    tracks = [t for t in a["tracks"] if t["title"] in cfg["tracks"]]
    if args:
        tracks = [t for t in tracks if any(albums.track(a, p) is t or (not p.isdigit() and p.lower() in t["title"].lower()) for p in args)]
    for d in ("24-bit 48kHz", "16-bit 44.1kHz"):
        os.makedirs(os.path.join(a["versions_dir"], d), exist_ok=True)
    if not a["released"]:
        print("-- checking starts and ends of the originals")
        edge_clean.clean_album(a["folder"], [str(t["n"]) for t in tracks])
    jobs = [(aid, t["id"], v) for t in tracks for v in cfg["tracks"][t["title"]]
            if only in (None, v)]
    report = load_report()
    print(f"-- rendering {len(jobs)} versions for album {aid}")
    with ProcessPoolExecutor(4) as ex:
        for r in ex.map(job, jobs):
            report[f"{aid}/{r['file']}"] = r
            print(f"{r['file'][:58]:58s} {int(r['dur'] // 60)}:{r['dur'] % 60:04.1f}  speed {r['speed']:.4f}  "
                  f"{r['I']:6.1f} LUFS (loud {r['loud']:5.1f})  peak {r['TP']:5.2f}  limiting {r['gr_mean']:.1f}/{r['gr_p95']:.1f} dB"
                  + (f"  [{r['source_note'][:60]}]" if r["source_note"] else ""), flush=True)
            json.dump(list(report.values()), open(REPORT, "w"), indent=1)
