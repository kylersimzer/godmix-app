"""Report the loudest point before the music starts and the first/last sample of every master."""
import glob, os
import numpy as np, soundfile as sf
import albums

ALBUM = os.path.join(albums.master_folder(), "Mastered")
for folder in ("24-bit 48kHz", "16-bit 44.1kHz"):
    print("==", folder)
    for p in sorted(glob.glob(os.path.join(ALBUM, folder, "*.wav")), key=lambda s: int(os.path.basename(s).split(".")[0])):
        x, fs = sf.read(p, always_2d=True)
        ms = fs // 1000
        a = np.abs(x).max(axis=1)
        pk = 20 * np.log10(a[: (len(a) // ms) * ms].reshape(-1, ms).max(axis=1) + 1e-9)
        onset = int(np.argmax(pk > -50))
        pre = pk[:max(onset - 5, 1)].max()
        db = lambda v: 20 * np.log10(np.abs(v).max() + 1e-9)
        print(f"  {os.path.basename(p)[:22]:22s} music at {onset:4d} ms, loudest before it {pre:6.1f} dBFS | "
              f"first sample {db(x[0]):6.1f} dBFS, last sample {db(x[-1]):6.1f} dBFS, last 5 ms peak {db(x[-5*ms:]):6.1f} dBFS")
