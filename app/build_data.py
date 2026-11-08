"""Build the GODMIX app's data for every album in albums.json (or the ones named):
  data/albums.json   the album list for the switcher
  data/<id>.json     per track: official number/title, loudness/peaks (original + master), tempo, key,
                     intro/outro character, loudness curve, waveform + peak/RMS envelope, clean-up status, versions,
                     and the file paths the server is allowed to play
Results are cached per file (size + mtime), so re-running after a change is quick.
Usage: python app/build_data.py [album id ...]     (no ids: every album whose folder exists here)"""
import sys, os, json, base64
import numpy as np
import librosa

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import mlib, albums
import versions as V
from version_design import official_bpm, precise_bpm, CONFIG_ALBUM, STEMS_CFG, VERSIONS

DATA = os.path.join(HERE, "data")
CACHE = os.path.join(HERE, "cache")
ANALYSIS_VERSION = 3   # bump to re-analyze cached tracks (2: precise tempo, 3: multi-album + official bpm)
ENV_FPS = 40           # waveform envelope frames per second (peak + RMS), drawn like stems.fm's tracks

MAJ = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MIN = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
NOTES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]
CAM_MAJ = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1]
CAM_MIN = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10]


def key_of(chroma):
    c = []
    for i in range(12):
        c.append((np.corrcoef(chroma, np.roll(MAJ, i))[0, 1], i, "maj"))
        c.append((np.corrcoef(chroma, np.roll(MIN, i))[0, 1], i, "min"))
    c.sort(reverse=True)
    r, i, mode = c[0]
    cam = f"{CAM_MAJ[i]}B" if mode == "maj" else f"{CAM_MIN[i]}A"
    return f"{NOTES[i]} {'major' if mode == 'maj' else 'minor'}", cam, float(r - c[1][0])


def stats(m):
    return {k: round(float(m[k]), 2) for k in ("I", "loud", "LRA", "TP")}


def analyze(a, t):
    x, fs = mlib.load(t["master"])
    after = stats(mlib.measure(x, fs))
    before = after if t["src"] == t["master"] else stats(mlib.measure(mlib.load(t["src"])[0], fs))
    st = mlib.short_term(x, fs, hop=0.5)
    loud = mlib.loud_section(st)
    y = librosa.resample(x.mean(axis=1), orig_sr=fs, target_sr=22050)
    rough = official_bpm(a["id"], t["n"]) or float(np.atleast_1d(librosa.beat.beat_track(y=y, sr=22050)[0])[0])
    tempo = precise_bpm(y, 22050, rough)
    chroma = librosa.feature.chroma_cqt(y=librosa.effects.harmonic(y), sr=22050).mean(axis=1)
    key, cam, margin = key_of(chroma)
    hop = fs // 10
    n = len(x) // hop
    wave = np.abs(x[: n * hop]).max(axis=1).reshape(n, hop).max(axis=1)
    return dict(
        dur=round(len(x) / fs, 3), before=before, after=after,
        bpm=round(tempo, 2), key=key, camelot=cam, key_sure=margin >= 0.08,
        start_lufs=round(float(st[0]), 1), end_lufs=round(float(st[-1]), 1),
        build_s=float(np.argmax(st >= loud - 3) * 0.5), fade_db=round(float(st[-1] - st[-21]), 1) if len(st) > 21 else 0.0,
        bright_hz=round(float(np.mean(librosa.feature.spectral_centroid(y=y, sr=22050)))),
        curve=[round(float(v), 1) for v in st[::2]], wave=[round(float(v), 3) for v in wave])


def envelope(x, fs):
    """The waveform the app draws: per 1/ENV_FPS s, the peak and the RMS of the louder channel, as bytes on a
    -60…0 dBFS scale (b = 0 is silence), interleaved [peak, rms, peak, rms, …] and base64-encoded."""
    hop = fs // ENV_FPS
    n = len(x) // hop
    if n == 0:
        return ""
    blk = x[: n * hop].reshape(n, hop, x.shape[1])
    peak = np.abs(blk).max(axis=(1, 2))
    rms = np.sqrt((blk ** 2).mean(axis=1)).max(axis=1)
    to_b = lambda v: np.clip(np.round((20 * np.log10(np.maximum(v, 1e-9)) + 60) / 60 * 255), 0, 255).astype(np.uint8)
    out = np.empty(n * 2, dtype=np.uint8)
    out[0::2], out[1::2] = to_b(peak), to_b(rms)
    return base64.b64encode(out.tobytes()).decode("ascii")


def env_cached(cdir, path):
    """Envelopes are cached on their own, so adding them didn't mean re-analysing every track."""
    f = os.path.join(cdir, os.path.basename(path) + ".env.json")
    key = sig(path)
    c = json.load(open(f)) if os.path.exists(f) else None
    if c and c.get("sig") == key and c.get("fps") == ENV_FPS:
        return c["env"]
    env = envelope(*mlib.load(path))
    json.dump(dict(sig=key, fps=ENV_FPS, env=env), open(f, "w"))
    return env


def sig(*paths):
    return [[os.stat(p).st_size, int(os.stat(p).st_mtime)] for p in paths]


def cached(path, key, make):
    c = json.load(open(path)) if os.path.exists(path) else None
    if c and c.get("sig") == key and c.get("v") == ANALYSIS_VERSION:
        return c["data"], False
    d = make()
    json.dump(dict(sig=key, v=ANALYSIS_VERSION, data=d), open(path, "w"))
    return d, True


def version_info(path):
    x, fs = mlib.load(path)
    hop = fs // 10
    n = len(x) // hop
    return dict(dur=round(len(x) / fs, 3), I=round(float(mlib.integrated(x, fs)), 2),
                wave=[round(float(v), 3) for v in np.abs(x[: n * hop]).max(axis=1).reshape(n, hop).max(axis=1)])


def release_info(aid):
    """ISRCs and release year: {n: isrc}, year. From the registry ("isrc" per track, "year" per album), with the
    stems.fm config (official_bpm's bpm_config) over it where the album is in it."""
    reg = next((x for x in albums.REG["albums"] if x["id"] == aid), {})
    base = ({t["n"]: t["isrc"] for t in reg["tracks"] if t.get("isrc")} if isinstance(reg.get("tracks"), list) else {}), reg.get("year")
    if aid not in CONFIG_ALBUM or not STEMS_CFG or not os.path.exists(STEMS_CFG):
        return base
    import datetime
    c = json.load(open(STEMS_CFG, encoding="utf-8"))
    songs = [s for s in c["songs"] if s["albumId"] == CONFIG_ALBUM[aid]]
    al = next((x for x in c.get("albums", []) if x["id"] == CONFIG_ALBUM[aid]), None)
    year = datetime.datetime.fromtimestamp(al["releaseDate"], datetime.timezone.utc).year if al and al.get("releaseDate") else None
    return {**base[0], **{s["trackNumber"]: s.get("isrc") for s in songs if s.get("isrc")}}, year or base[1]


def edge_info(log, tid):
    e = log.get(tid)
    if not e:
        return None
    done = list(e.get("history", [])) + ([{k: e.get(k) for k in ("when", "action", "reasons")}] if e["action"] not in ("none", "flag") else [])
    return dict(flag=bool(e.get("flag")), flag_reason=e["reasons"][0] if e.get("flag") else None,
                cleaned=[{"when": (h.get("when") or "")[:10], "action": h["action"], "reasons": h["reasons"]} for h in done])


def build(aid):
    a = albums.album(aid)
    cdir = os.path.join(CACHE, aid)
    os.makedirs(cdir, exist_ok=True)
    log_path = os.path.join(os.path.dirname(HERE), "edge_clean_log.json")
    log = json.load(open(log_path)) if (os.path.exists(log_path) and not a["released"]) else {}
    vcfg = V.album_cfg(aid)
    isrcs, year = release_info(aid)
    tracks = []
    for t in a["tracks"]:
        if not os.path.exists(t["master"]):
            continue
        d, fresh = cached(os.path.join(cdir, t["id"] + ".json"), sig(t["src"], t["master"]), lambda: analyze(a, t))
        if fresh:
            print(f"  analyzed {t['n']:2d}. {t['title']}  {d['bpm']} bpm  {d['camelot']}")
        d = dict(d, name=t["id"], n=t["n"], title=t["title"], stem=t["stem"], edge=edge_info(log, t["id"]), isrc=isrcs.get(t["n"]),
                 env=env_cached(cdir, t["master"]),
                 paths=dict(orig=t["src"], master=t["master"], versions={}))
        d["versions"] = []
        for label in vcfg["tracks"].get(t["title"], []):
            p = V.version_path(a, t, label)
            if not os.path.exists(p):
                continue
            w, fresh = cached(os.path.join(cdir, os.path.basename(p) + ".json"), sig(p), lambda: version_info(p))
            if fresh:
                print(f"  analyzed version {os.path.basename(p)}")
            d["versions"].append(dict(label=label, speed=V.recipe_for(aid, t["title"], label).get("speed", 1.0), env=env_cached(cdir, p), **w))
            d["paths"]["versions"][label] = p
        tracks.append(d)
    out = dict(id=aid, title=a["title"], subtitle=a.get("subtitle", ""), artist=a.get("artist", ""), env_fps=ENV_FPS,
               released=a["released"], demo=bool(a.get("demo")), year=year,
               version_kinds=[k for k in VERSIONS if k in V.VCFG["recipes"]], folder=a["folder"],
               masters_folder=os.path.join(a["folder"], os.path.dirname(a["masters"])) if a.get("masters") else None,
               versions_folder=a["versions_dir"], tracks=tracks)
    json.dump(out, open(os.path.join(DATA, f"{aid}.json"), "w", encoding="utf-8"), ensure_ascii=False)
    print(f"wrote data/{aid}.json: {len(tracks)} tracks, {sum(len(t['versions']) for t in tracks)} versions")
    return dict(id=aid, title=a["title"], subtitle=a.get("subtitle", ""), artist=a.get("artist", ""),
                released=a["released"], demo=bool(a.get("demo")), tracks=len(tracks), art=art_of(tracks))


def art_of(tracks, n=240):
    """A small picture of the album for the homepage's cards: its loudness, start to finish in album order,
    as n points (short-term LUFS), and where each track begins as a fraction of the whole."""
    curves = [t["curve"] for t in tracks]
    seq = [v for c in curves for v in c]
    if not seq:
        return dict(curve=[], bounds=[])
    pts = [round(max(seq[int(i * len(seq) / n): max(int(i * len(seq) / n) + 1, int((i + 1) * len(seq) / n))]), 1) for i in range(n)]
    bounds, pos = [], 0
    for c in curves:
        bounds.append(round(pos / len(seq), 4)); pos += len(c)
    return dict(curve=pts, bounds=bounds)


def rebuild(ids=None):
    """Build the named albums (default: every album whose folder is on this machine) and the album list."""
    os.makedirs(DATA, exist_ok=True)
    here = albums.available_ids()
    ids = ids or here
    index_path = os.path.join(DATA, "albums.json")
    index = {x["id"]: x for x in (json.load(open(index_path, encoding="utf-8")) if os.path.exists(index_path) else [])}
    for aid in ids:
        if aid not in here:
            print(f"== album {aid}: folder not found ({albums.album(aid)['folder']}), skipped")
            continue
        print(f"== album {aid}")
        index[aid] = build(aid)
    order = albums.all_ids()
    json.dump([index[i] for i in order if i in index], open(index_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    rebuild(sys.argv[1:])
