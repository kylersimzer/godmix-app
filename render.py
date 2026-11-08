"""Render album masters: loud-section-matched, true-peak limited, 24/48 + 16/44.1 dithered."""
import sys, os, re, glob, json, subprocess, tempfile
import numpy as np
import soundfile as sf
from scipy import signal
from concurrent.futures import ProcessPoolExecutor
import mlib
import edge_clean
import albums
from sweep import render_to
from trace_tags import find_ffmpeg

SRC = albums.master_folder()          # the album being mastered: the one with "masters" in local/albums.json
OUT = os.path.join(SRC, "Mastered")
HI = os.path.join(OUT, "24-bit 48kHz")
CD = os.path.join(OUT, "16-bit 44.1kHz")
FFMPEG = find_ffmpeg()                # PATH, GODMIX_FFMPEG or a WinGet install; the codec checks need it

CFG = albums.layered("render_cfg.json")   # render_cfg.json with local/render_cfg.json over it


def codec_peaks(wav):
    """Encode like the stores do and report the decoded sample peak (dBFS) per codec."""
    res = {}
    with tempfile.TemporaryDirectory() as d:
        for name, args, ext in [("mp3_320", ["-c:a", "libmp3lame", "-b:a", "320k"], "mp3"),
                                ("aac_256", ["-c:a", "aac", "-b:a", "256k"], "m4a"),
                                ("opus_160", ["-c:a", "libopus", "-b:a", "160k"], "opus"),
                                ("vorbis_q9", ["-c:a", "libvorbis", "-q:a", "9"], "ogg")]:
            enc = os.path.join(d, "t." + ext)
            dec = os.path.join(d, "t_" + ext + ".wav")
            subprocess.run([FFMPEG, "-v", "error", "-y", "-i", wav, *args, enc], check=True)
            subprocess.run([FFMPEG, "-v", "error", "-y", "-i", enc, "-c:a", "pcm_f32le", dec], check=True)
            y, _ = sf.read(dec, dtype="float32")
            res[name] = float(20 * np.log10(np.abs(y).max() + 1e-20))
    return res


def job(p):
    name = os.path.basename(p)
    x, fs = mlib.load(p)
    before = mlib.measure(x, fs)
    xh = mlib.highpass(x, fs)
    # per-track level offsets (dB), keyed by song title so they survive renumbering: "Song Name": -1.0
    title = albums.song_title(name)
    offsets = CFG.get("offsets", {})
    target = CFG["target"] + offsets.get(title, offsets.get(name, 0.0))
    y, info, gain = render_to(xh, fs, target, ceiling_db=CFG["ceiling"], **CFG["chain"])
    y = mlib.edge_fades(y, fs)
    # 24-bit / 48 kHz
    hi_path = os.path.join(HI, mlib.master_filename(name, "hi"))
    # masters used to be saved without the format label; don't leave an old copy next to the new one
    for old in (os.path.join(HI, name), os.path.join(CD, name)):
        if os.path.exists(old):
            os.remove(old)
    sf.write(hi_path, mlib.tpdf_dither_quantize(y, 24), fs, subtype="PCM_24")
    # 16-bit / 44.1 kHz: resample, re-check the true-peak ceiling, dither
    y44 = signal.resample_poly(y, 147, 160, axis=0)
    y44, gr44 = mlib.limiter(y44, 44100, CFG["ceiling"] - 0.05, 1.0, 40.0)
    y44 = mlib.edge_fades(y44, 44100)
    cd_path = os.path.join(CD, mlib.master_filename(name, "cd"))
    sf.write(cd_path, mlib.tpdf_dither_quantize(y44, 16), 44100, subtype="PCM_16")
    yh, _ = sf.read(hi_path, dtype="float64", always_2d=True)
    yc, _ = sf.read(cd_path, dtype="float64", always_2d=True)
    after = mlib.measure(yh, fs)
    after_cd = mlib.measure(yc, 44100)
    gr1 = info["gr1"]
    sig = np.mean(y ** 2)
    return dict(name=name, gain=gain, target=target, before=before, after=after, after_cd=after_cd,
                gr_mean=float(gr1.mean()), gr_p95=float(np.percentile(gr1, 95)), gr_max=float(gr1.max()),
                clip_db=float(10 * np.log10(np.mean(info["clip_res"] ** 2) / sig + 1e-20)),
                codec_peaks=codec_peaks(hi_path))


if __name__ == "__main__":
    os.makedirs(HI, exist_ok=True)
    os.makedirs(CD, exist_ok=True)
    # first, clean the start static / end clicks off the originals (backs up, cuts only clear cases, flags the rest)
    print("-- checking starts and ends of the originals")
    edge_clean.clean_album(SRC, sys.argv[1:])
    print("-- mastering")
    files = sorted(glob.glob(os.path.join(SRC, "*.wav")))
    # optional args: only re-render these tracks (track number or whole words of the title); keep the rest of the report
    report_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "render_report.json")
    rows = []
    if len(sys.argv) > 1:
        files = edge_clean.pick(files, sys.argv[1:])
        names = {os.path.basename(f) for f in files}
        current = {os.path.basename(f) for f in glob.glob(os.path.join(SRC, "*.wav"))}
        by_title = {albums.song_title(n): n for n in current}
        # keep other tracks' rows; a renumbered track keeps its row under its new name; drop removed tracks
        rows = []
        for t in json.load(open(report_path))["tracks"]:
            if t["name"] not in current:
                t["name"] = by_title.get(albums.song_title(t["name"]), t["name"])
            if t["name"] in current and t["name"] not in names and all(r["name"] != t["name"] for r in rows):
                rows.append(t)
    with ProcessPoolExecutor(3) as ex:
        for r in ex.map(job, files):
            rows.append(r)
            b, a = r["before"], r["after"]
            print(f"{r['name'][:24]:24s} I {b['I']:6.1f} -> {a['I']:6.1f}  loud {b['loud']:6.1f} -> {a['loud']:6.1f}  "
                  f"TP {b['TP']:5.1f} -> {a['TP']:5.2f} (cd {r['after_cd']['TP']:5.2f})  LRA {b['LRA']:4.1f} -> {a['LRA']:4.1f}  "
                  f"GRmean {r['gr_mean']:3.1f} p95 {r['gr_p95']:3.1f}  clip {r['clip_db']:6.1f}dB  codecs "
                  + " ".join(f"{k}={v:5.2f}" for k, v in r["codec_peaks"].items()), flush=True)
    json.dump(dict(config=CFG, tracks=rows), open(report_path, "w"), indent=1)
