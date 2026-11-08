"""How harsh / sibilant a file's top end is.
  hi_vs_mid  : energy above 5 kHz vs 300 Hz-5 kHz (overall brightness of the top end)
  ess_peaks  : how far the loudest 1% of 5-10 kHz moments jump above that band's typical level
               (big numbers = spiky "s", "t", "ch" sounds and hats that poke out)
Usage: python harsh_check.py <wav> [<wav> ...]"""
import sys, os
import numpy as np
from scipy import signal
import mlib


def harsh(path):
    x, fs = mlib.load(path)
    return harsh_arr(x, fs)


def harsh_arr(x, fs):
    m = x.mean(axis=1)
    band = lambda lo, hi: signal.sosfilt(signal.butter(4, [lo, hi], "bandpass", fs=fs, output="sos"), m)
    mid, top, ess = band(300, 5000), band(5000, 16000), band(5000, 10000)
    blk = fs // 200                                    # 5 ms
    n = len(ess) // blk
    e = 10 * np.log10(np.mean(ess[: n * blk].reshape(n, blk) ** 2, axis=1) + 1e-14)
    e = e[e > e.max() - 60]
    return 10 * np.log10(np.sum(top ** 2) / np.sum(mid ** 2)), float(np.percentile(e, 99) - np.median(e))


if __name__ == "__main__":
    for p in sys.argv[1:]:
        h, s = harsh(p)
        print(f"{os.path.basename(p)[:52]:52s} top end vs mids {h:6.1f} dB | 's' peaks jump {s:5.1f} dB above typical")
