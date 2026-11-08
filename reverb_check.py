"""Compare reverb settings: how loud the reverb sits under the dry (slowed) song.
Reports the reverb-to-dry ratio overall, in the loud parts (where wash muddies vocals/drums)
and in the quiet parts (where reverb should bloom). Usage: python reverb_check.py "<title>" [recipe names...]"""
import sys, os, glob, json
import numpy as np
import mlib, albums
from versions import vinyl_speed, reverb_send


def ratios(dry, wet, fs):
    # compare above 300 Hz, where vocals, drums and the reverb actually compete (the sub isn't sent to the reverb)
    from scipy import signal
    sos = signal.butter(4, 300, "highpass", fs=fs, output="sos")
    dry, wet = signal.sosfilt(sos, dry, axis=0), signal.sosfilt(sos, wet, axis=0)
    blk = int(fs * 0.4)
    n = min(len(dry), len(wet)) // blk
    d = np.mean(dry[: n * blk].reshape(n, blk, -1) ** 2, axis=(1, 2))
    w = np.mean(wet[: n * blk].reshape(n, blk, -1) ** 2, axis=(1, 2))
    loud = d >= np.percentile(d, 80)
    quiet = (d <= np.percentile(d, 30)) & (d > 0)
    db = lambda a, b: 10 * np.log10(a.sum() / b.sum())
    return db(w, d), db(w[loud], d[loud]), db(w[quiet], d[quiet])


if __name__ == "__main__":
    # python reverb_check.py --album demo "song title"   -> depth of that song's current Slowed + Reverb reverb
    import albums, versions as V
    aid = sys.argv[sys.argv.index("--album") + 1] if "--album" in sys.argv else albums.default_id()
    picks = [p for i, p in enumerate(sys.argv[1:], 1) if p != "--album" and sys.argv[i - 1] != "--album"]
    a = albums.album(aid)
    for t in a["tracks"]:
        if picks and not any(p.lower() in t["title"].lower() or p == str(t["n"]) for p in picks):
            continue
        rec = V.recipe_for(aid, t["title"], "Slowed + Reverb")
        x, fs, _ = V.load_source(a, t)
        dry = V.make_version(x, fs, dict(rec, reverb=None, tail_s=0))
        _, wet = reverb_send(dry, fs, rec["reverb"])
        o, l, q = ratios(dry, wet, fs)
        print(f"{t['title'][:28]:28s} reverb vs dry: overall {o:6.1f} dB | in loud parts {l:6.1f} dB | in quiet parts {q:6.1f} dB")
