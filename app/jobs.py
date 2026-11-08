"""GODMIX jobs: the work the app asks for, run by the server one at a time (or by hand).

  make     design (where needed) and render versions that don't exist yet, then refresh the app's data
           python app/jobs.py make --album 000 [--track <id> ...] [--version "Sped Up" ...]
  export   write tagged song files and/or one full-album file from a spec (JSON, written by the server)
           python app/jobs.py export spec.json
  album    add an album from a folder, or change an album's title, subtitle or artist (spec JSON from the server)
           python app/jobs.py album spec.json      {"action": "add" | "edit", "id"?, "title", "subtitle", "artist", "folder"?}
  trace    Trace Tags: one tagged copy per recipient of each song, written down in app/state/trace-tags.json
           python app/jobs.py trace spec.json      {"album", "items": [{"id", "title"}], "version", "recipients": [...],
                                                    "phrase", "voice": "male" | "female", "say_name", "clips": [file names
                                                    in app/state/trace-clips], "density": "light" | "normal" | "heavy",
                                                    "formats": ["wav", "mp3"]}
  trace-check  whose copy is a leaked file?    python app/jobs.py trace-check spec.json   {"file"} (deleted after if the app uploaded it)

Progress goes to stdout as lines starting with "@@ " and a JSON object {"p": 0–1, "msg": "..."}; the last one
carries "result". Released albums are never written to: versions go under <album>/Versions, exports under
<album>/Exports.

Export spec:
  {"album": "000", "what": "songs" | "album" | "both", "version": "" | "Slowed + Reverb" | ...,
   "items": [{"id": "<track id>", "title": "Blue"}, ...]        # in running order; numbered 1..n
   "gap": 2, "formats": [see FORMATS], "meta": {"artist", "album_artist", "album", "year", "genre", "label",
   "composer", "copyright", "comment"}, "isrc": {"<track id>": "QZS652557969"}, "cover": "<image path>" | null}
Formats: the file as made (WAV, AIFF, FLAC and ALAC keep its samples bit for bit), WAV at 24-bit 48 kHz, 24-bit
44.1 kHz and 16-bit 44.1 kHz (a change of rate is resampled and true-peak limited, a change of depth dithered),
and MP3 320 / AAC 256 (ALAC, MP3 and AAC need ffmpeg). Every file is tagged: ID3v2.4 in WAV, AIFF and MP3, Vorbis
comments in FLAC, MP4 atoms in ALAC/AAC; title, artist, album artist, album, track n/total, year, genre, label,
composer, copyright, comment, ISRC and the cover.
"""
import os, sys, re, json, glob, shutil, datetime, subprocess
import numpy as np
import soundfile as sf
from scipy import signal

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
sys.path.insert(0, HERE)
import mlib, albums
import versions as V


def say(p, msg, **extra):
    """One progress line for the server: p = share done (None leaves the bar where it is)."""
    print("@@ " + json.dumps(dict(p=None if p is None else round(float(p), 3), msg=msg, **extra)), flush=True)


def safe(s):
    return re.sub(r'[\\/:*?"<>|]', "", s).strip().rstrip(".")


# ─────────────────────────────────────────────────────────── make versions
def make(aid, track_ids=None, labels=None):
    from version_design import design, VERSIONS, DESIGNED
    import build_data
    a = albums.album(aid)
    cfg = V.album_cfg(aid)
    labels = [l for l in VERSIONS if l in (labels or VERSIONS)]
    tracks = [t for t in a["tracks"] if not track_ids or t["id"] in track_ids]
    todo = [(t, l) for t in tracks for l in labels if not os.path.exists(V.version_path(a, t, l))]
    if not todo:
        say(1, "Nothing to make: those versions already exist", result=dict(made=[]))
        return
    # 1. design the songs that have never been designed (keeping any settings already tuned by hand)
    need = [t for t in {id(t): t for t, l in todo}.values()
            if any(not cfg["overrides"].get(t["title"], {}).get(l) for tt, l in todo if tt is t and l in DESIGNED)]
    plan_path = albums.plan_path(aid)
    plan = json.load(open(plan_path, encoding="utf-8")) if os.path.exists(plan_path) else {}
    for i, t in enumerate(need):
        say(0.05 + 0.25 * i / max(1, len(need)), f"Designing {t['title']} from its measurements")
        title, over, info = design((aid, t["id"]))
        o = cfg["overrides"].setdefault(title, {})
        for k, v in over.items():
            o.setdefault(k, v)
        plan.setdefault(title, info)
    for t, l in todo:
        have = cfg["tracks"].setdefault(t["title"], [])
        if l not in have:
            have.append(l)
        cfg["tracks"][t["title"]] = [x for x in VERSIONS if x in have] + [x for x in have if x not in VERSIONS]
    V.save_vcfg()
    if need:
        plan_path = albums.plan_path(aid, write=True)
        os.makedirs(os.path.dirname(plan_path), exist_ok=True)
        json.dump(plan, open(plan_path, "w", encoding="utf-8"), indent=1, ensure_ascii=False)
    # 2. render
    for d in ("24-bit 48kHz", "16-bit 44.1kHz"):
        os.makedirs(os.path.join(a["versions_dir"], d), exist_ok=True)
    report, made = V.load_report(), []
    for i, (t, l) in enumerate(todo):
        say(0.3 + 0.6 * i / len(todo), f"Rendering {t['title']} ({l})")
        r = V.job((aid, t["id"], l))
        report[f"{aid}/{r['file']}"] = r
        json.dump(list(report.values()), open(V.REPORT, "w"), indent=1)
        made.append(dict(track=t["id"], version=l, file=r["file"], I=round(r["I"], 1), TP=round(r["TP"], 2)))
    # 3. refresh the app
    say(0.92, "Measuring the new files for the app")
    build_data.rebuild([aid])
    say(1, f"Made {len(made)} version{'s' if len(made) != 1 else ''}", result=dict(made=made))


# ─────────────────────────────────────────────────────────── export
def find_ffmpeg():
    cands = [os.environ.get("GODMIX_FFMPEG"), shutil.which("ffmpeg")]
    local = os.environ.get("LOCALAPPDATA")
    if local:
        cands += glob.glob(os.path.join(local, "Microsoft", "WinGet", "Packages", "*FFmpeg*", "**", "bin", "ffmpeg.exe"), recursive=True)
    return next((c for c in cands if c and os.path.exists(c)), None)


# key: (label for file names, container, sample rate or None = as made, bits or None = as made)
FORMATS = {
    "wav":       ("", "wav", None, None),
    "wav24_48":  ("24-bit 48kHz", "wav", 48000, 24),
    "wav24_441": ("24-bit 44.1kHz", "wav", 44100, 24),
    "wav16":     ("16-bit 44.1kHz", "wav", 44100, 16),
    "aiff":      ("", "aiff", None, None),
    "flac":      ("", "flac", None, None),
    "alac":      ("", "alac", None, None),
    "mp3":       ("", "mp3", None, None),
    "aac":       ("", "aac", None, None),
}
SCALE = {"PCM_16": 32768.0, "PCM_24": 2147483648.0, "FLOAT": 1.0}


def cd_sibling(path):
    """The 16-bit 44.1 kHz render next to a 24-bit 48 kHz one, if there is one."""
    alt = path.replace("24-bit 48kHz", "16-bit 44.1kHz") if path else path
    return alt if alt and alt != path and os.path.exists(alt) else None


def read_exact(path):
    """Samples as integers in the file's own format, so writing them back is bit-exact."""
    info = sf.info(path)
    dtype, sub = ("int16", "PCM_16") if info.subtype == "PCM_16" else ("int32", "PCM_24") if info.subtype == "PCM_24" else ("float32", "FLOAT")
    x, fs = sf.read(path, dtype=dtype, always_2d=True)
    return x, fs, sub


def convert(x, fs, sub, to_fs, to_bits):
    """Integer audio → another rate and/or bit depth, the way versions.py makes its CD copies: a rate change is
    resampled and limited under the true-peak ceiling, and every requantisation is dithered."""
    to_sub = "PCM_16" if to_bits == 16 else "PCM_24"
    if fs == to_fs and sub == to_sub:
        return x, fs, sub
    if fs == to_fs and sub == "PCM_16" and to_sub == "PCM_24":     # more bits, same rate: exact, nothing to dither
        return x.astype(np.int32) << 16, fs, to_sub
    xf = x.astype(np.float64) / SCALE[sub]
    if fs != to_fs:
        g = np.gcd(to_fs, fs)
        xf = signal.resample_poly(xf, to_fs // g, fs // g, axis=0)
        xf, _ = mlib.limiter(xf, to_fs, V.CFG["ceiling"] - 0.05, 1.0, 40.0)
    q = mlib.tpdf_dither_quantize(xf, to_bits)
    return (q * (32768 if to_bits == 16 else 2147483648)).astype(np.int16 if to_bits == 16 else np.int32), to_fs, to_sub


def tag(path, t, meta, cover):
    """Write the tags (and the cover) into a WAV, AIFF, FLAC, MP3 or M4A (ALAC/AAC) file."""
    from mutagen.id3 import ID3, TIT2, TPE1, TPE2, TALB, TRCK, TDRC, TCON, TPUB, TCOM, TCOP, COMM, TSRC, APIC, TSSE
    ext = os.path.splitext(path)[1].lower()
    m = {k: str(v).strip() for k, v in (meta or {}).items() if v not in (None, "")}
    img = open(cover, "rb").read() if cover and os.path.exists(cover) else None
    png = bool(cover) and cover.lower().endswith(".png")
    mime = "image/png" if png else "image/jpeg"
    if ext == ".flac":
        from mutagen.flac import FLAC, Picture
        f = FLAC(path)
        for key, val in [("TITLE", t["title"]), ("ARTIST", m.get("artist")), ("ALBUMARTIST", m.get("album_artist")), ("ALBUM", m.get("album")),
                         ("TRACKNUMBER", str(t["n"])), ("TRACKTOTAL", str(t["total"])), ("DATE", m.get("year")), ("GENRE", m.get("genre")),
                         ("ORGANIZATION", m.get("label")), ("COMPOSER", m.get("composer")), ("COPYRIGHT", m.get("copyright")),
                         ("COMMENT", m.get("comment")), ("ISRC", t.get("isrc")), ("ENCODER", "GODMIX")]:
            if val:
                f[key] = val
        if img:
            pic = Picture(); pic.type = 3; pic.mime = mime; pic.desc = "Cover"; pic.data = img
            f.clear_pictures(); f.add_picture(pic)
        f.save()
        return
    if ext == ".m4a":
        from mutagen.mp4 import MP4, MP4Cover, MP4FreeForm
        f = MP4(path)
        for key, val in [("\xa9nam", t["title"]), ("\xa9ART", m.get("artist")), ("aART", m.get("album_artist")), ("\xa9alb", m.get("album")),
                         ("\xa9day", m.get("year")), ("\xa9gen", m.get("genre")), ("\xa9wrt", m.get("composer")), ("cprt", m.get("copyright")),
                         ("\xa9cmt", m.get("comment")), ("\xa9too", "GODMIX")]:
            if val:
                f[key] = [val]
        f["trkn"] = [(t["n"], t["total"])]
        if m.get("label"):
            f["----:com.apple.iTunes:LABEL"] = [MP4FreeForm(m["label"].encode("utf-8"))]
        if t.get("isrc"):
            f["----:com.apple.iTunes:ISRC"] = [MP4FreeForm(t["isrc"].encode("utf-8"))]
        if img:
            f["covr"] = [MP4Cover(img, imageformat=MP4Cover.FORMAT_PNG if png else MP4Cover.FORMAT_JPEG)]
        f.save()
        return
    if ext in (".wav", ".aiff"):
        from mutagen.wave import WAVE
        from mutagen.aiff import AIFF
        f = (WAVE if ext == ".wav" else AIFF)(path)
        if f.tags is None:
            f.add_tags()
        tags = f.tags
    else:
        try:
            tags = ID3(path)
        except Exception:
            tags = ID3()
    frames = [TIT2(encoding=3, text=t["title"]), TRCK(encoding=3, text=f"{t['n']}/{t['total']}"), TSSE(encoding=3, text="GODMIX")]
    for cls, key in [(TPE1, "artist"), (TPE2, "album_artist"), (TALB, "album"), (TDRC, "year"), (TCON, "genre"), (TPUB, "label"), (TCOM, "composer"), (TCOP, "copyright")]:
        if m.get(key):
            frames.append(cls(encoding=3, text=m[key]))
    if m.get("comment"):
        frames.append(COMM(encoding=3, lang="eng", desc="", text=m["comment"]))
    if t.get("isrc"):
        frames.append(TSRC(encoding=3, text=t["isrc"]))
    if img:
        frames.append(APIC(encoding=3, mime=mime, type=3, desc="Cover", data=img))
    for fr in frames:
        tags.add(fr)
    if ext in (".wav", ".aiff"):
        f.save()
    else:
        tags.save(path, v2_version=4)


def write_formats(base, src_hi, formats, t, meta, cover, ffmpeg, data=None):
    """One song (or the full album) in each asked-for format. `data` = (int samples, fs, subtype) if already in
    memory (the full album); otherwise it's read from `src_hi`. WAVs that differ only in rate/depth get the
    spec in their name when more than one WAV is asked for; a WAV identical to another isn't written twice."""
    out, made = [], {}
    x, fs, sub = data or read_exact(src_hi)
    wavs = [k for k in formats if FORMATS.get(k, ("", ""))[1] == "wav"]
    tmp = None

    def as_made_wav():                 # a plain WAV of the audio, for ffmpeg to encode from
        nonlocal tmp
        if src_hi and src_hi.lower().endswith(".wav"):
            return src_hi
        if not tmp:
            tmp = base + ".tmp.wav"; sf.write(tmp, x, fs, subtype=sub)
        return tmp

    for k in formats:
        if k not in FORMATS:
            continue
        label, kind, to_fs, to_bits = FORMATS[k]
        if kind == "wav":
            spec = (fs, sub) if to_fs is None else (to_fs, "PCM_16" if to_bits == 16 else "PCM_24")
            if spec in made:
                continue
            name = base + (f" ({label})" if len(wavs) > 1 and label else "") + ".wav"
            sib = cd_sibling(src_hi) if (k == "wav16" and data is None) else None
            if to_fs is None and data is None and src_hi.lower().endswith(".wav"):
                shutil.copyfile(src_hi, name)                       # the file itself, untouched
            elif sib:
                shutil.copyfile(sib, name)                          # the 16-bit render versions.py already made
            else:
                y, yfs, ysub = (x, fs, sub) if to_fs is None else convert(x, fs, sub, to_fs, to_bits)
                sf.write(name, y, yfs, subtype=ysub)
            made[spec] = name
        elif kind == "aiff":
            name = base + ".aiff"; sf.write(name, x, fs, subtype=sub if sub != "FLOAT" else "PCM_24", format="AIFF")
        elif kind == "flac":
            name = base + ".flac"; sf.write(name, x, fs, subtype=sub if sub != "FLOAT" else "PCM_24", format="FLAC")
        else:                                                       # alac, mp3, aac: encoded by ffmpeg
            if not ffmpeg:
                say(None, f"{k.upper()} skipped: ffmpeg not found (install it, or set GODMIX_FFMPEG)")
                continue
            codec = {"alac": ["-c:a", "alac"], "mp3": ["-c:a", "libmp3lame", "-b:a", "320k"], "aac": ["-c:a", "aac", "-b:a", "256k"]}[kind]
            name = base + (" (ALAC).m4a" if kind == "alac" and "aac" in formats else " (AAC).m4a" if kind == "aac" and "alac" in formats else ".m4a" if kind in ("alac", "aac") else ".mp3")
            subprocess.run([ffmpeg, "-v", "error", "-y", "-i", as_made_wav(), "-map", "0:a", *codec, "-map_metadata", "-1", name], check=True)
        tag(name, t, meta, cover)
        out.append(name)
    if tmp and os.path.exists(tmp):
        os.remove(tmp)
    return out


def cue_time(s):
    fr = int(round(s * 75))
    return f"{fr // 4500:02d}:{(fr // 75) % 60:02d}:{fr % 75:02d}"


def export(spec_path):
    spec = json.load(open(spec_path, encoding="utf-8"))
    aid, version, formats = spec["album"], spec.get("version") or "", spec.get("formats") or ["wav"]
    a = albums.album(aid)
    by_id = {t["id"]: t for t in a["tracks"]}
    items = [dict(i, n=k + 1) for k, i in enumerate(spec["items"]) if i["id"] in by_id]
    meta, cover, ffmpeg = spec.get("meta") or {}, spec.get("cover"), find_ffmpeg()
    total, isrc = len(items), spec.get("isrc") or {}
    album_name = meta.get("album") or f"{a['title']} {a.get('subtitle', '')}".strip()
    stamp = datetime.datetime.now().strftime("%Y-%m-%d %H%M")
    # "folder" in the spec puts the files somewhere else (the homepage's demo download uses the app's cache)
    folder = spec.get("folder") or os.path.join(a["folder"], "Exports", safe(f"{album_name}{' (' + version + ')' if version else ''} {stamp}"))
    os.makedirs(folder, exist_ok=True)
    if cover and os.path.exists(cover):
        shutil.copyfile(cover, os.path.join(folder, "cover" + os.path.splitext(cover)[1].lower()))
    # each song's source: the chosen version where it exists, else the album master
    srcs, fell_back = [], []
    for it in items:
        t = by_id[it["id"]]
        vp = V.version_path(a, t, version) if version else None
        if vp and os.path.exists(vp):
            srcs.append(vp)
        else:
            srcs.append(t["master"])
            if version:
                fell_back.append(it["title"])
    files, what = [], spec.get("what", "songs")
    steps = (total if what in ("songs", "both") else 0) + (total + 2 if what in ("album", "both") else 0)
    done = 0
    if what in ("songs", "both"):
        sub_dir = folder if what == "songs" else os.path.join(folder, "Songs")
        os.makedirs(sub_dir, exist_ok=True)
        for it, src in zip(items, srcs):
            title = it["title"] + (f" ({version})" if version and it["title"] not in fell_back else "")
            say(done / steps, f"Writing {it['n']:02d}. {title}")
            t = dict(title=title, n=it["n"], total=total, isrc=isrc.get(it["id"]))
            files += write_formats(os.path.join(sub_dir, safe(f"{it['n']:02d}. {title}")), src, formats, t, meta, cover, ffmpeg)
            done += 1
    if what in ("album", "both"):
        gap = float(spec.get("gap", 2))
        loaded = []
        for it, src in zip(items, srcs):
            say(done / steps, f"Joining {it['n']:02d}. {it['title']}")
            loaded.append(read_exact(src)); done += 1
        same = len({(fs, sub) for _, fs, sub in loaded}) == 1
        if same:
            fs, sub = loaded[0][1], loaded[0][2]
            parts = [x for x, _, _ in loaded]
        else:     # mixed formats: everything to 24-bit 48 kHz
            fs, sub, parts = 48000, "PCM_24", []
            for x, f0, s0 in loaded:
                xf = x.astype(np.float64) / (32768.0 if s0 == "PCM_16" else 2147483648.0 if s0 == "PCM_24" else 1.0)
                if f0 != fs:
                    g = np.gcd(fs, f0); xf = signal.resample_poly(xf, fs // g, f0 // g, axis=0)
                parts.append((mlib.tpdf_dither_quantize(xf, 24) * 2147483648.0).astype(np.int32))
        silence = np.zeros((int(round(gap * fs)), parts[0].shape[1]), dtype=parts[0].dtype)
        starts, pieces, pos = [], [], 0
        for k, x in enumerate(parts):
            starts.append(pos / fs); pieces.append(x); pos += len(x)
            if k < len(parts) - 1:
                pieces.append(silence); pos += len(silence)
        full = np.concatenate(pieces)
        say(done / steps, f"Writing the full album ({mlib_fmt(len(full) / fs)})")
        name = safe(f"{album_name} (Full Album{', ' + version if version else ''})")
        t = dict(title=f"{album_name} (Full Album{', ' + version if version else ''})", n=1, total=1)
        full_files = write_formats(os.path.join(folder, name), None, formats, t, meta, cover, ffmpeg, data=(full, fs, sub))
        files += full_files
        done += 1
        # a cue sheet and a tracklist with start times, for burning or for listening notes
        perf = meta.get("artist", "")
        cue_file = os.path.basename(next((f for f in full_files if f.endswith(".wav")), full_files[0] if full_files else name + ".wav"))
        cue = [f'PERFORMER "{perf}"', f'TITLE "{album_name}"', f'FILE "{cue_file}" WAVE']
        for it, st in zip(items, starts):
            cue += [f"  TRACK {it['n']:02d} AUDIO", f'    TITLE "{it["title"]}"', f'    PERFORMER "{perf}"']
            if isrc.get(it["id"]):
                cue.append(f"    ISRC {isrc[it['id']].replace('-', '')}")
            cue.append(f"    INDEX 01 {cue_time(st)}")
        open(os.path.join(folder, name + ".cue"), "w", encoding="utf-8").write("\n".join(cue) + "\n")
        files.append(os.path.join(folder, name + ".cue"))
        ends = [st + len(x) / fs for st, x in zip(starts, parts)]
        lines = [f"{it['n']}. {it['title']} {clock(st)} - {clock(en)}" for it, st, en in zip(items, starts, ends)]
        open(os.path.join(folder, "Tracklist.txt"), "w", encoding="utf-8").write(f"{album_name}\n\n" + "\n".join(lines) + "\n")
    else:
        open(os.path.join(folder, "Tracklist.txt"), "w", encoding="utf-8").write(f"{album_name}\n\n" + "\n".join(f"{it['n']}. {it['title']}" for it in items) + "\n")
    note = f" ({len(fell_back)} without {version} used the album version)" if fell_back else ""
    say(1, f"Exported {len(files)} file{'s' if len(files) != 1 else ''}{note}", result=dict(folder=folder, files=[os.path.basename(f) for f in files], fell_back=fell_back))


def clock(s):
    """00:00, or 1:02:03 past an hour: the times in a running order."""
    s = int(s)
    return f"{s // 3600}:{s % 3600 // 60:02d}:{s % 60:02d}" if s >= 3600 else f"{s // 60:02d}:{s % 60:02d}"


# ─────────────────────────────────────────────────────────── albums
def album_job(spec_path):
    import build_data
    spec = json.load(open(spec_path, encoding="utf-8"))
    reg = albums.REG
    text = lambda k, n=80: str(spec.get(k) or "").strip()[:n]
    if spec["action"] == "edit":
        a = next(x for x in reg["albums"] if x["id"] == spec["id"])
        a["title"] = text("title") or a["title"]
        a["subtitle"] = text("subtitle")
        artist = text("artist")
        if artist: a["artist"] = artist
        else: a.pop("artist", None)
        albums.save_registry(reg)
        # the measurements don't change, so the app's data is patched rather than rebuilt
        for f in (os.path.join(build_data.DATA, f"{a['id']}.json"), os.path.join(build_data.DATA, "albums.json")):
            if not os.path.exists(f):
                continue
            d = json.load(open(f, encoding="utf-8"))
            for x in (d if isinstance(d, list) else [d]):
                if x["id"] == a["id"]:
                    x.update(title=a["title"], subtitle=a["subtitle"], artist=a.get("artist", ""))
            json.dump(d, open(f, "w", encoding="utf-8"), ensure_ascii=False, indent=1 if isinstance(d, list) else None)
        say(1, f"Saved {a['title']}", result=dict(album=a["id"]))
        return
    folder = os.path.abspath(text("folder", 1000))
    if not os.path.isdir(folder):
        raise ValueError(f"No folder at {folder}")
    same = next((x for x in reg["albums"] if os.path.normcase(os.path.abspath(albums.album(x["id"])["folder"])) == os.path.normcase(folder)), None)
    if same:
        raise ValueError(f"That folder is already the album {same['title']}")
    tracks = albums.tracks_from_folder(folder)
    if not tracks:
        raise ValueError("That folder has no WAV, FLAC or AIFF files")
    title = text("title") or os.path.basename(folder)
    base = re.sub(r"[^\w!.&' -]", "", title).strip()[:30] or "album"
    aid, k = base, 2
    while any(x["id"] == aid for x in reg["albums"]):
        aid, k = f"{base} {k}", k + 1
    a = dict(id=aid, title=title, subtitle=text("subtitle"), folder=folder.replace("\\", "/"), released=True, tracks=tracks)
    if text("artist"):
        a["artist"] = text("artist")
    reg["albums"].append(a)
    albums.save_registry(reg)
    say(0.1, f"Added {title} ({len(tracks)} songs). Measuring them for the app…")
    build_data.rebuild([aid])
    say(1, f"Added {title}: {len(tracks)} songs", result=dict(album=aid))


# ─────────────────────────────────────────────────────────── Trace Tags
def trace(spec_path):
    """One traceable copy per recipient of each song (trace_tags.py), written down in the ledger."""
    import trace_tags as TT
    spec = json.load(open(spec_path, encoding="utf-8"))
    a = albums.album(spec["album"])
    by_id = {t["id"]: t for t in a["tracks"]}
    items = [dict(i, n=k + 1) for k, i in enumerate(spec["items"]) if i["id"] in by_id]
    people = [p for p in spec["recipients"] if p]
    version, formats, density = spec.get("version") or "", spec.get("formats") or ["wav"], spec.get("density") or "normal"
    ffmpeg = find_ffmpeg() if "mp3" in formats else None
    if "mp3" in formats and not ffmpeg:
        say(None, "MP3 skipped: ffmpeg not found (install it, or set GODMIX_FFMPEG)")
    stamp = datetime.datetime.now()
    folder = os.path.join(a["folder"], "Exports", safe(f"Trace Tags {stamp.strftime('%Y-%m-%d %H%M')}"))
    tmp = os.path.join(HERE, "cache", "trace")
    os.makedirs(tmp, exist_ok=True)
    key = TT.secret_key()

    # the tag clips: typed words (spoken once), recordings, and each person's name if asked
    say(0.01, "Making the tags…")
    base = []
    if (spec.get("phrase") or "").strip():
        base.append(dict(desc=f"words: {spec['phrase'].strip()}", file=TT.speak(spec["phrase"], os.path.join(tmp, "phrase.wav"), spec.get("voice", "male"))))
    for c in spec.get("clips") or []:
        f = os.path.join(TT.CLIPS, c)
        if os.path.exists(f):
            base.append(dict(desc=f"recording: {c}", file=f))
    if not base:
        raise ValueError("Add some words or a recording for the tag")
    name_files = {}
    if spec.get("say_name"):
        for k, p in enumerate(people):
            name_files[p] = TT.speak(f"For {p}.", os.path.join(tmp, f"name-{k}.wav"), spec.get("voice", "male"))

    total, done, ledger, files = len(items) * len(people), 0, [], []
    for it in items:
        t = by_id[it["id"]]
        vp = V.version_path(a, t, version) if version else None
        src = vp if vp and os.path.exists(vp) else t["master"]
        x, fs = mlib.load(src)
        lvl, blk = TT.loudness_track(x, fs)
        clips = [dict(audio=TT.prep_clip(c["file"], fs), desc=c["desc"]) for c in base]
        for p in people:
            say(0.03 + 0.95 * done / total, f"{it['title']} for {p} ({done + 1} of {total})")
            cl = clips + ([dict(audio=TT.prep_clip(name_files[p], fs), desc=f"name: {p}", name=True)] if p in name_files else [])
            for c in cl:
                c["len"] = len(c["audio"]) / fs
            plan = TT.make_plan(f"{key}|{p}|{a['id']}|{t['id']}|{version}|{stamp.isoformat()}", len(x) / fs, lvl, blk, fs,
                                [dict(len=c["len"], name=c.get("name", False)) for c in cl], density)
            y = TT.render(x, fs, cl, plan, lvl, blk)
            out_dir = os.path.join(folder, safe(p))
            os.makedirs(out_dir, exist_ok=True)
            name = os.path.join(out_dir, safe(f"{it['n']:02d}. {it['title']}{' (' + version + ')' if version else ''}"))
            sf.write(name + ".wav", mlib.tpdf_dither_quantize(y, 24), fs, subtype="PCM_24")
            meta = dict(artist=a.get("artist", ""), album=a["title"], comment=f"Trace Tag copy for {p}")
            tinfo = dict(title=it["title"] + (f" ({version})" if version else ""), n=it["n"], total=len(items))
            made = []
            if "mp3" in formats and ffmpeg:
                subprocess.run([ffmpeg, "-v", "error", "-y", "-i", name + ".wav", "-c:a", "libmp3lame", "-b:a", "320k", "-map_metadata", "-1", name + ".mp3"], check=True)
                tag(name + ".mp3", tinfo, meta, None); made.append(name + ".mp3")
            if "wav" in formats:
                tag(name + ".wav", tinfo, meta, None); made.append(name + ".wav")
            else:
                os.remove(name + ".wav")
            files += made
            ledger.append(dict(id=hashlib_id(), made=stamp.isoformat(timespec="seconds"), album=a["id"], track=t["id"], title=it["title"],
                               version=version, recipient=p, source=os.path.abspath(src), density=density,
                               clips=[c["desc"] for c in cl], plan=plan, files=[os.path.abspath(f) for f in made]))
            done += 1
    TT.add_to_ledger(ledger)
    say(1, f"Made {len(ledger)} Trace Tag cop{'y' if len(ledger) == 1 else 'ies'} for {', '.join(people)}",
        result=dict(folder=folder, files=files, made=[c["id"] for c in ledger]))


def hashlib_id():
    import secrets
    return secrets.token_hex(4)


def trace_check(spec_path):
    """Whose copy is this leaked file? (trace_tags.identify)"""
    import trace_tags as TT
    spec = json.load(open(spec_path, encoding="utf-8"))
    say(0.1, "Listening for the tags…")
    r = TT.identify(spec["file"])
    if os.path.abspath(spec["file"]).startswith(os.path.join(HERE, "cache", "trace") + os.sep):
        os.remove(spec["file"])                  # a leak uploaded through the app isn't kept
    say(1, r["msg"], result=dict(match=r))


def mlib_fmt(s):
    s = int(round(s))
    return f"{s // 3600}:{s % 3600 // 60:02d}:{s % 60:02d}" if s >= 3600 else f"{s // 60}:{s % 60:02d}"


if __name__ == "__main__":
    args = sys.argv[1:]
    try:
        if args[:1] == ["make"]:
            def opt(name):
                return [args[i + 1] for i, x in enumerate(args) if x == name and i + 1 < len(args)]
            make(opt("--album")[0], opt("--track") or None, opt("--version") or None)
        elif args[:1] == ["export"]:
            export(args[1])
        elif args[:1] == ["album"]:
            album_job(args[1])
        elif args[:1] == ["trace"]:
            trace(args[1])
        elif args[:1] == ["trace-check"]:
            trace_check(args[1])
        else:
            print(__doc__); sys.exit(2)
    except Exception as e:
        import traceback; traceback.print_exc()
        print("@@ " + json.dumps(dict(p=1, msg=f"Failed: {e}", error=str(e))), flush=True)
        sys.exit(1)
