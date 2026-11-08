import sys, glob, os, json
import numpy as np
from scipy import signal
import mlib, albums

SRC = albums.master_folder()          # the album being mastered (local/albums.json)
BANDS = [(0, 20), (20, 60), (60, 250), (250, 2000), (2000, 6000), (6000, 12000), (12000, 24000)]
NAMES = ["<20", "sub", "bass", "lowmid", "himid", "pres", "air"]

rows = []
for p in sorted(glob.glob(os.path.join(SRC, "*.wav"))):
    x, fs = mlib.load(p)
    m = mlib.measure(x, fs)
    mono = x.mean(axis=1)
    f, P = signal.welch(mono, fs, nperseg=16384)
    tot = P[(f >= 20)].sum()
    bands = {n: 10 * np.log10(P[(f >= lo) & (f < hi)].sum() / tot + 1e-20) for n, (lo, hi) in zip(NAMES, BANDS)}
    L, R = x[:, 0], x[:, 1]
    corr = float(np.sum(L * R) / np.sqrt(np.sum(L * L) * np.sum(R * R)))
    side = 10 * np.log10(np.sum((L - R) ** 2) / np.sum((L + R) ** 2))
    a = np.abs(x).max(axis=1)
    nz = np.nonzero(a > 10 ** (-60 / 20))[0]
    lead, tail = nz[0] / fs, (len(a) - nz[-1]) / fs
    m.update(name=os.path.basename(p), dur=len(x) / fs, corr=corr, side_db=float(side),
             dc=float(np.abs(x.mean(axis=0)).max()), lead=lead, tail=tail, **{k: float(v) for k, v in bands.items()})
    rows.append(m)
    print(f"{m['name'][:24]:24s} I={m['I']:6.1f} loud={m['loud']:6.1f} LRA={m['LRA']:4.1f} TP={m['TP']:5.1f} "
          f"PLR={m['TP']-m['I']:4.1f} corr={corr:4.2f} side={side:5.1f} lead={lead:4.2f}s tail={tail:4.2f}s | "
          + " ".join(f"{n}={bands[n]:6.1f}" for n in NAMES), flush=True)

json.dump(rows, open(os.path.join(os.path.dirname(__file__), "analysis.json"), "w"), indent=1)
