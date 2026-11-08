"""Check an album's slowed versions: tempo, tuning (near 0 cents = A440), tone vs each song's target
(its master's top end minus 3.1 dB), "s" peaks, and perceived loudness relative to its master.
Optionally auto-correct the tone: --fix adjusts the high shelf of any song more than 0.8 dB off target.
Usage: python slowed_verify.py --album 000 [--fix]"""
import os, sys, json
import numpy as np
import librosa
import mlib, perceived_loudness as pl, albums
import versions as V
from harsh_check import harsh_arr

HERE = os.path.dirname(os.path.abspath(__file__))
VER = "Slowed + Reverb"


def check(args):
    aid, tid = args
    a = albums.album(aid)
    t = albums.track(a, tid)
    x, fs = mlib.load(V.version_path(a, t, VER))
    y = librosa.resample(x.mean(axis=1), orig_sr=fs, target_sr=22050)
    tun = float(librosa.estimate_tuning(y=librosa.effects.harmonic(y), sr=22050, resolution=0.005) * 100)
    top, ess = harsh_arr(x, fs)
    mx, _ = mlib.load(t["master"])
    mtop = harsh_arr(mx, fs)[0]
    return t["title"], tun, top, mtop - 3.1, ess, pl.perceived(x, fs)[0] - pl.perceived(mx, fs)[0]


if __name__ == "__main__":
    from concurrent.futures import ProcessPoolExecutor
    aid = sys.argv[sys.argv.index("--album") + 1] if "--album" in sys.argv else albums.default_id()
    a = albums.album(aid)
    plan = json.load(open(albums.plan_path(aid), encoding="utf-8")) if os.path.exists(albums.plan_path(aid)) else {}
    tracks = [t for t in a["tracks"] if VER in V.album_cfg(aid)["tracks"].get(t["title"], []) and os.path.exists(V.version_path(a, t, VER))]
    fixes = {}
    with ProcessPoolExecutor(4) as ex:
        for title, tun, top, target, ess, dph in ex.map(check, [(aid, t["id"]) for t in tracks]):
            bpm = plan.get(title, {}).get("slowed_bpm")
            off = top - target
            print(f"{title[:28]:28s} {('%.1f bpm' % bpm) if bpm else '':>10s} | tuning {tun:+5.1f}c | top {top:6.1f} dB (target {target:6.1f}, {off:+.1f}) "
                  f"| 's' peaks {ess:4.1f} | vs master {dph:+.1f} phon", flush=True)
            if abs(off) > 0.8:
                fixes[title] = off
    if "--fix" in sys.argv and fixes:
        cfg = V.album_cfg(aid)
        for title, off in fixes.items():
            cur = V.recipe_for(aid, title, VER)["high_shelf"]["db"]
            new = float(np.clip(round((cur - off / 0.8) * 2) / 2, -4.0, 3.0))     # ~0.8 dB of top end per dB of shelf
            cfg["overrides"].setdefault(title, {}).setdefault(VER, {})["high_shelf"] = {"db": new}
            print(f"  tone fix {title}: shelf {cur:+.1f} -> {new:+.1f} dB")
        V.save_vcfg()
        print("re-render:", " ".join(str(albums.track(a, t)["n"]) for t in fixes))
