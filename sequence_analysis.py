"""Facts for album sequencing: tempo, key, energy, and how each track starts and ends."""
import glob, os, json
import numpy as np
import librosa
import mlib, albums

SRC = os.path.join(albums.master_folder(), "Mastered", "24-bit 48kHz")
MAJ = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MIN = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
NOTES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]
# Camelot wheel numbers for major (B) and minor (A) keys, indexed by tonic
CAM_MAJ = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1]
CAM_MIN = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10]


def key_of(chroma):
    best = []
    for i in range(12):
        best.append((np.corrcoef(chroma, np.roll(MAJ, i))[0, 1], i, "maj"))
        best.append((np.corrcoef(chroma, np.roll(MIN, i))[0, 1], i, "min"))
    best.sort(reverse=True)
    r, i, mode = best[0]
    cam = f"{CAM_MAJ[i]}B" if mode == "maj" else f"{CAM_MIN[i]}A"
    return f"{NOTES[i]} {'major' if mode == 'maj' else 'minor'}", cam, float(r), float(r - best[1][0])


rows = []
for p in sorted(glob.glob(os.path.join(SRC, "*.wav")), key=lambda s: int(os.path.basename(s).split(".")[0])):
    x, fs = mlib.load(p)
    st = mlib.short_term(x, fs, hop=0.5)  # one value per 0.5 s
    loud = mlib.loud_section(st)
    y = librosa.resample(x.mean(axis=1), orig_sr=fs, target_sr=22050)
    tempo, _ = librosa.beat.beat_track(y=y, sr=22050)
    onset_rate = len(librosa.onset.onset_detect(y=y, sr=22050)) / (len(y) / 22050)
    harm = librosa.effects.harmonic(y)
    chroma = librosa.feature.chroma_cqt(y=harm, sr=22050).mean(axis=1)
    key, cam, kr, margin = key_of(chroma)
    cent = float(np.mean(librosa.feature.spectral_centroid(y=y, sr=22050)))
    dur = len(x) / fs
    # first window index (0.5 s hop) where the track gets within 3 dB of its loud level
    reach = np.argmax(st >= loud - 3) * 0.5
    end_slope = st[-1] - st[-21]  # change over the last ~10 s
    rows.append(dict(name=os.path.basename(p)[:-4], dur=dur, bpm=float(np.atleast_1d(tempo)[0]), key=key, camelot=cam,
                     key_conf=kr, key_margin=margin, onsets_per_s=onset_rate, centroid=cent, loud=loud,
                     start_lufs=float(st[0]), reach_full_s=float(reach), end_lufs=float(st[-1]), end_slope=float(end_slope)))
    r = rows[-1]
    print(f"{r['name'][:22]:22s} {dur/60:4.1f}m  {r['bpm']:6.1f} bpm  {key:9s} ({cam:3s} conf {kr:.2f}/+{margin:.2f})  "
          f"onsets {onset_rate:4.1f}/s  bright {cent:5.0f}Hz  start {r['start_lufs']:6.1f} full@{reach:5.1f}s  "
          f"end {r['end_lufs']:6.1f} (last10s {end_slope:+5.1f}dB)", flush=True)

json.dump(rows, open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "sequence_analysis.json"), "w"), indent=1)
