import sys, glob, os, json
import numpy as np
from concurrent.futures import ProcessPoolExecutor
import mlib
TARGETS = [-9.0, -8.0, -7.0, -6.0]


def render_to(x, fs, target, **kw):
    """Find input gain so the loud-section loudness of the output hits `target`."""
    m0 = mlib.loud_section(mlib.short_term(x, fs, hop=0.5))
    gain = target - m0
    for _ in range(4):
        y, info = mlib.chain(x, fs, gain, **kw)
        lo = mlib.loud_section(mlib.short_term(y, fs, hop=0.5))
        if abs(lo - target) < 0.05:
            break
        gain += target - lo
    return y, info, gain


def stats(x, y, info, fs, gain):
    m = mlib.measure(y, fs)
    gr1 = info["gr1"]
    sig = np.sqrt(np.mean(y ** 2))
    res = np.sqrt(np.mean(info["clip_res"] ** 2))
    return dict(gain=gain, I=m["I"], loud=m["loud"], TP=m["TP"], LRA=m["LRA"], PLR=m["TP"] - m["I"],
                gr_mean=float(gr1.mean()), gr_p95=float(np.percentile(gr1, 95)), gr_max=float(gr1.max()),
                gr_gt3=float((gr1 > 3).mean() * 100), clip_db=float(20 * np.log10(res / sig + 1e-20)),
                clip_pct=float((np.abs(info["clip_res"]) > 1e-4).mean() * 100),
                gr2_max=float(info["gr2"].max()))


def job(p):
    x, fs = mlib.load(p)
    x = mlib.highpass(x, fs)
    out = {}
    for t in TARGETS:
        y, info, g = render_to(x, fs, t)
        out[t] = stats(x, y, info, fs, g)
    return os.path.basename(p), out


if __name__ == "__main__":
    import albums
    files = sorted(glob.glob(os.path.join(albums.master_folder(), "*.wav")))
    res = {}
    with ProcessPoolExecutor(int(sys.argv[1]) if len(sys.argv) > 1 else 3) as ex:
        for name, out in ex.map(job, files):
            res[name] = out
            for t, s in out.items():
                print(f"{name[:22]:22s} tgt={t:5.1f} gain={s['gain']:5.1f} I={s['I']:6.1f} TP={s['TP']:5.2f} PLR={s['PLR']:4.1f} "
                      f"LRA={s['LRA']:4.1f} GRmean={s['gr_mean']:4.1f} GRp95={s['gr_p95']:4.1f} GRmax={s['gr_max']:4.1f} "
                      f">3dB={s['gr_gt3']:5.1f}% clip={s['clip_db']:6.1f}dB clip%={s['clip_pct']:4.1f} fin={s['gr2_max']:4.2f}", flush=True)
    json.dump(res, open("sweep.json", "w"), indent=1)
