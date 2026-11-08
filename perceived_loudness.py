"""How loud the masters' loudest parts SOUND, using the ISO 532-1 (Zwicker) hearing model.
LUFS weights frequencies only roughly; Zwicker models the ear's sensitivity and masking, so it
catches bright tracks (strong 2-5 kHz) that sound louder than their LUFS suggests.
Usage: python perceived_loudness.py ["title words" ...]   (prints phons per track; 1 phon ~ 1 dB of level)
Named songs are the reference the others are compared with; without names, the album average is."""
import glob, os, sys
import numpy as np
from mosqito.sq_metrics import loudness_zwst
import mlib, albums

CAL_DB_SPL = 90.0          # 0 dBFS = 90 dB SPL (a loud-ish listening level); same for every track
PA = 20e-6 * 10 ** (CAL_DB_SPL / 20)


def phon(sones):
    return 40 + 33.22 * np.log10(np.maximum(sones, 1e-3)) if sones >= 1 else 40 * (sones + 0.0005) ** 0.35


def loud_windows(x, fs, k=6, win=3.0):
    """Start times of the k loudest non-overlapping 3 s windows."""
    st = mlib.short_term(x, fs, hop=0.5)
    order, picked = np.argsort(st)[::-1], []
    for i in order:
        if all(abs(i - j) >= int(win / 0.5) for j in picked):
            picked.append(i)
        if len(picked) == k:
            break
    return [i * 0.5 for i in picked], st


def perceived(x, fs, gain_db=0.0):
    starts, st = loud_windows(x, fs)
    g = 10 ** (gain_db / 20)
    ph, lu = [], []
    for s in starts:
        seg = x[int(s * fs): int((s + 3) * fs)] * g
        N, _, _ = loudness_zwst(seg.mean(axis=1) * PA, fs, field_type="free")
        ph.append(phon(float(N)))
        lu.append(mlib.integrated(seg, fs))
    return float(np.mean(ph)), float(np.mean(lu))


if __name__ == "__main__":
    MASTERS = os.path.join(albums.master_folder(), "Mastered", "24-bit 48kHz")
    refs = [a.lower() for a in sys.argv[1:]]
    rows = {}
    for p in sorted(glob.glob(os.path.join(MASTERS, "*.wav")), key=lambda s: int(os.path.basename(s).split(".")[0])):
        x, fs = mlib.load(p)
        ph, lu = perceived(x, fs)
        rows[os.path.basename(p)] = (ph, lu)
        print(f"{os.path.basename(p)[:36]:36s} sounds like {ph:5.1f} phon   (LUFS of the same parts {lu:6.1f})", flush=True)
    picked = [v[0] for k, v in rows.items() if not refs or any(r in k.lower() for r in refs)] or [v[0] for v in rows.values()]
    ref = np.mean(picked)
    print(f"\n{'Reference songs' if refs else 'Album'} average: {ref:.1f} phon")
    for k, v in rows.items():
        print(f"  {k[:36]:36s} {v[0] - ref:+5.1f} phon vs that average")
