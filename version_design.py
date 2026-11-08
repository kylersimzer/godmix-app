"""Design every song's versions from its own measurements (rules distilled from a hand-designed set of versions).

  Slowed + Reverb
    speed   whole-semitone drop, tuned to A440:  -2 st if already slow (<105 bpm) or dark + near-mono,
            -4 st if very fast (>=150 bpm), else -3 st
    tone    de-esser only where the master's "s" peaks spike (>=15 dB); high shelf searched so the slowed
            top end sits 3.1 dB under the song's own master (the relationship approved by ear on the hand-made set)
    reverb  depth under the dry song: -6 dB, drier for many hits/s and for songs that sit near full level,
            wetter for near-mono or very dynamic songs (clamped -9.5..-5.5); wet level calibrated to hit it
  Sped Up   +3 st (>=120 bpm) or +4 st, tuned to A440
  Other Room  the shared recipe
  Bass Boosted, Max Bass Boost  the shared recipes; versions.bass_boost sets each song's boost from its own lows

Writes the album's tracks + overrides (versions.save_vcfg) and its plan (local/plans/<id>.json): measurements
+ reasons. Nothing in the repo itself changes.
Usage: python version_design.py --album 000 [--keep-existing]"""
import os, sys, json, math
import numpy as np
import librosa
from scipy import signal
import mlib, albums
import versions as V
from harsh_check import harsh_arr
from reverb_check import ratios

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_ALBUM = {"000": 0, "O": 1, "111": 2, "demo": 0}   # album ids in the stems.fm config (official bpm); the demo is 000
# optional: a stems.fm config with each song's official BPM (GODMIX_BPM_CONFIG, or "bpm_config" in local/settings.json)
STEMS_CFG = os.environ.get("GODMIX_BPM_CONFIG") or albums.settings().get("bpm_config") or ""
VERSIONS = ["Slowed + Reverb", "Sped Up", "Other Room", "Bass Boosted", "Max Bass Boost"]
DESIGNED = {"Slowed + Reverb", "Sped Up"}          # the ones design() writes per-song settings for
CLASSIC = ["Slowed + Reverb", "Sped Up", "Other Room"]   # what a full album design lists; the bass ones are made on request
BASE = V.VCFG["recipes"]["Slowed + Reverb"]


def official_bpm(aid, n):
    if aid not in CONFIG_ALBUM or not STEMS_CFG or not os.path.exists(STEMS_CFG):
        return None
    c = json.load(open(STEMS_CFG, encoding="utf-8"))
    s = next((s for s in c["songs"] if s["albumId"] == CONFIG_ALBUM[aid] and s["trackNumber"] == n), None)
    return float(s["bpm"]) if s else None


def precise_bpm(y, sr, rough):
    hop = 64
    o = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)
    o = o - o.mean()
    fr = sr / hop
    score = lambda bpm: max(o[np.round(np.arange(ph, len(o) - 1, 60 / bpm * fr)).astype(int)].mean()
                            for ph in np.linspace(0, 60 / bpm * fr, 48, endpoint=False))
    grid = np.arange(rough * 0.95, rough * 1.05, 0.05)
    best = grid[np.argmax([score(b) for b in grid])]
    fine = np.arange(best - 0.1, best + 0.1, 0.005)
    return float(fine[np.argmax([score(b) for b in fine])])


def excerpt(x, fs, seconds=75):
    st = mlib.short_term(x, fs, hop=1.0)
    if len(st) <= seconds:
        return x
    c = int(np.argmax(np.convolve(st, np.ones(seconds) / seconds, mode="valid")))
    return x[c * fs: (c + seconds) * fs]


def measure(a, t):
    x, fs = V.load_source(a, t)[:2]
    y = librosa.resample(x.mean(axis=1), orig_sr=fs, target_sr=22050)
    harm = librosa.effects.harmonic(y)
    rough = official_bpm(a["id"], t["n"]) or float(np.atleast_1d(librosa.beat.beat_track(y=y, sr=22050)[0])[0])
    hp = signal.sosfilt(signal.butter(4, 300, "highpass", fs=22050, output="sos"), y)
    blk = 22050 // 10
    e = 10 * np.log10(np.mean(hp[: len(hp) // blk * blk].reshape(-1, blk) ** 2, axis=1) + 1e-14)
    e = e[e > e.max() - 50]
    L, R = x[:, 0], x[:, 1]
    mx, _ = mlib.load(t["master"])
    top, ess = harsh_arr(mx, fs)
    return x, fs, dict(
        bpm=round(precise_bpm(y, 22050, rough), 2), bpm_official=official_bpm(a["id"], t["n"]),
        tuning_cents=round(float(librosa.estimate_tuning(y=harm, sr=22050, resolution=0.005) * 100), 1),
        onsets_per_s=round(len(librosa.onset.onset_detect(y=y, sr=22050)) / (len(y) / 22050), 2),
        busy=round(float(np.mean(e > np.percentile(e, 95) - 6)), 2),
        stereo_corr=round(float(np.sum(L * R) / np.sqrt(np.sum(L * L) * np.sum(R * R) + 1e-20)), 2),
        lra=round(mlib.lra(mlib.short_term(x, fs, hop=0.5)), 1), master_top=round(top, 1), master_ess=round(ess, 1))


def design(args):
    aid, tid = args
    a = albums.album(aid)
    t = albums.track(a, tid)
    x, fs, m = measure(a, t)
    why = []
    # --- Slowed + Reverb: speed
    dark_mono = m["master_top"] < -15 and m["stereo_corr"] > 0.95
    if m["bpm"] < 105:
        semis = 2; why.append(f"already {m['bpm']:.0f} bpm: gentle -2 st")
    elif dark_mono:
        semis = 2; why.append("dark and near-mono: gentle -2 st so it doesn't go muddy")
    elif m["bpm"] >= 150:
        semis = 4; why.append(f"fast ({m['bpm']:.0f} bpm): deeper -4 st")
    else:
        semis = 3; why.append("-3 st")
    speed = round(2 ** ((-semis - m["tuning_cents"] / 100) / 12), 5)
    slowed_bpm = m["bpm"] * speed
    # --- tone
    dry = V.vinyl_speed(excerpt(x, fs), speed)
    use_deess = m["master_ess"] >= 15
    if use_deess:
        dry = V.deess(dry, fs, BASE["deess"])
    target_top = m["master_top"] - 3.1
    shelf = float(min(np.arange(-3.0, 2.01, 0.5),
                      key=lambda g: abs(harsh_arr(V.high_shelf(dry, fs, dict(BASE["high_shelf"], db=g)), fs)[0] - target_top)))
    shelved = V.high_shelf(dry, fs, dict(BASE["high_shelf"], db=shelf))
    # --- reverb depth (dB under the dry song, above 300 Hz)
    depth = -6.0 - 0.6 * max(0, m["onsets_per_s"] - 2.5) - 8 * max(0, m["busy"] - 0.5) \
            + (1.0 if m["stereo_corr"] > 0.95 else 0) + (0.5 if m["lra"] > 12 else 0)
    depth = float(np.clip(depth, -9.5, -5.5))
    why.append(f"reverb {depth:+.1f} dB ({m['onsets_per_s']:.1f} hits/s, busy {m['busy']:.2f}"
               + (", near-mono" if m["stereo_corr"] > 0.95 else "") + (", very dynamic" if m["lra"] > 12 else "") + ")")
    rev = dict(BASE["reverb"], room_size=0.88 if depth >= -6.5 else 0.85 if depth >= -8 else 0.8,
               duck_db=8 if depth <= -8 else 6, predelay_ms=round(60000 / slowed_bpm / 12))
    _, wet1 = V.reverb_send(shelved, fs, dict(rev, wet=1.0))
    wet = float(np.clip(10 ** ((depth - ratios(shelved, wet1, fs)[0]) / 20), 0.05, 0.6))
    slowed = {"speed": speed, "high_shelf": {"db": shelf},
              "reverb": {k: rev[k] for k in ("room_size", "duck_db", "predelay_ms")} | {"wet": round(wet, 3)}}
    if not use_deess:
        slowed["deess"] = None
    # --- Sped Up
    up = 3 if m["bpm"] >= 120 else 4
    sped = {"speed": round(2 ** ((up - m["tuning_cents"] / 100) / 12), 5)}
    info = dict(m, slowed_semis=-semis, slowed_speed=speed, slowed_bpm=round(slowed_bpm, 1), deess=use_deess, shelf=shelf,
                reverb_depth=round(depth, 1), wet=round(wet, 3), sped_semis=up, sped_bpm=round(m["bpm"] * sped["speed"], 1), why=why)
    return t["title"], {"Slowed + Reverb": slowed, "Sped Up": sped}, info


if __name__ == "__main__":
    from concurrent.futures import ProcessPoolExecutor
    aid = sys.argv[sys.argv.index("--album") + 1]
    a = albums.album(aid)
    cfg = V.album_cfg(aid)
    os.makedirs(os.path.dirname(albums.plan_path(aid, write=True)), exist_ok=True)
    plan = {}
    with ProcessPoolExecutor(4) as ex:
        for title, over, info in ex.map(design, [(aid, t["id"]) for t in a["tracks"]]):
            have = cfg["tracks"].get(title, [])
            cfg["tracks"][title] = [v for v in VERSIONS if v in CLASSIC or v in have] + [v for v in have if v not in VERSIONS]
            cfg["overrides"].setdefault(title, {}).update(over)
            plan[title] = info
            print(f"{title[:28]:28s} {info['bpm']:6.1f} bpm  slowed {info['slowed_semis']:+d} st -> {info['slowed_bpm']:5.1f}  "
                  f"shelf {info['shelf']:+4.1f}  de-ess {'on ' if info['deess'] else 'off'}  reverb {info['reverb_depth']:+5.1f}  "
                  f"| sped +{info['sped_semis']} st -> {info['sped_bpm']:5.1f}  | tuning {info['tuning_cents']:+.1f}c", flush=True)
    V.save_vcfg()
    json.dump(plan, open(albums.plan_path(aid, write=True), "w", encoding="utf-8"), indent=1, ensure_ascii=False)
