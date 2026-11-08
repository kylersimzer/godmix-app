"""Build what the online demo serves (node app/server.js --demo), into app/cache/public (or GODMIX_PUBLIC_DIR):

  audio/<song>/master.mp3            MP3 320 copy of each demo song, for streaming
  audio/<song>/orig.mp3              only where the original differs from the master (never, for a released album)
  audio/<song>/<version label>.mp3   each version the demo has, e.g. "Slowed + Reverb.mp3"
  download/01. Blue.{wav,flac,mp3}   the homepage's tagged download, made exactly as the app exports a song
  cover.png | cover.jpg              the demo's cover, if one is set in the app (app/state/covers/demo.*)

Run it after build_data.py, and again whenever the demo's versions change:
  python app/build_public.py [--force]      (--force remakes every file; otherwise only missing or older ones)

The folder is everything the server needs besides the repo and app/data, so it's what gets copied to the
server. The audio in it is the demo album's: (c) Kyler Simzer, all rights reserved (see NOTICE.md).
"""
import os, sys, json, shutil, subprocess, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import jobs

DATA = os.environ.get("GODMIX_DATA_DIR") or os.path.join(HERE, "data")
PUBLIC = os.environ.get("GODMIX_PUBLIC_DIR") or os.path.join(HERE, "cache", "public")
STATE = os.environ.get("GODMIX_STATE_DIR") or os.path.join(HERE, "state")
DEMO = "demo"
DOWNLOAD_SONG = "Blue"


def stale(src, dst, force):
    return force or not os.path.exists(dst) or os.path.getmtime(dst) < os.path.getmtime(src)


def mp3(ffmpeg, src, dst):
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    tmp = dst + ".part.mp3"
    # 320k CBR with the LAME header ffmpeg writes by default, so browsers trim the encoder delay (gapless play-through)
    subprocess.run([ffmpeg, "-v", "error", "-y", "-i", src, "-map", "0:a", "-c:a", "libmp3lame", "-b:a", "320k",
                    "-map_metadata", "-1", tmp], check=True)
    os.replace(tmp, dst)


def main(force=False):
    path = os.path.join(DATA, f"{DEMO}.json")
    if not os.path.exists(path):
        sys.exit(f"No demo data at {path}. Build it first: python app/build_data.py {DEMO}")
    a = json.load(open(path, encoding="utf-8"))
    ffmpeg = jobs.find_ffmpeg()
    if not ffmpeg:
        sys.exit("ffmpeg not found (install it, or set GODMIX_FFMPEG)")

    # 1 · streaming copies
    made = kept = 0
    for t in a["tracks"]:
        song = os.path.join(PUBLIC, "audio", os.path.splitext(t["name"])[0])
        todo = [(t["paths"]["master"], "master")]
        if os.path.normcase(t["paths"]["orig"]) != os.path.normcase(t["paths"]["master"]):
            todo.append((t["paths"]["orig"], "orig"))
        todo += [(p, label) for label, p in (t["paths"].get("versions") or {}).items()]
        for src, name in todo:
            dst = os.path.join(song, f"{name}.mp3")
            if not stale(src, dst, force):
                kept += 1
                continue
            print(f"  {t['title']}: {name}")
            mp3(ffmpeg, src, dst)
            made += 1
    print(f"Streaming copies: {made} made, {kept} already up to date")

    # 2 · the homepage's download, tagged as the app's export writes it (the same settings as server.js's demoExport)
    t = next((x for x in a["tracks"] if x["title"] == DOWNLOAD_SONG), a["tracks"][0])
    out = os.path.join(PUBLIC, "download")
    have = os.path.isdir(out) and all(any(f.lower().endswith("." + e) for f in os.listdir(out)) for e in ("wav", "flac", "mp3"))
    if force or not have or any(stale(t["paths"]["master"], os.path.join(out, f), False) for f in os.listdir(out) if f[:2].isdigit()):
        shutil.rmtree(out, ignore_errors=True)
        year, artist = str(a.get("year") or datetime.date.today().year), a.get("artist") or ""
        cover = next((p for p in (os.path.join(STATE, "covers", f"{DEMO}.{e}") for e in ("png", "jpg")) if os.path.exists(p)),
                     os.path.join(ROOT, "design", "logo", "godmix-mark-white-on-black-1024.png"))
        spec = {"album": DEMO, "what": "songs", "version": "", "items": [{"id": t["name"], "title": t["title"]}], "gap": 0,
                "formats": ["wav", "flac", "mp3"],
                "meta": {"artist": artist, "album_artist": artist, "album": a["title"], "year": year, "genre": "", "label": "",
                         "composer": artist, "copyright": f"© {year} {artist}. All rights reserved." if artist else "",
                         "comment": "Exported by GODMIX"},
                "isrc": {t["name"]: t["isrc"]} if t.get("isrc") else {}, "cover": cover if os.path.exists(cover) else None, "folder": out}
        os.makedirs(os.path.join(HERE, "cache", "jobs"), exist_ok=True)
        spec_path = os.path.join(HERE, "cache", "jobs", "public-download.json")
        json.dump(spec, open(spec_path, "w", encoding="utf-8"))
        try:
            jobs.export(spec_path)
        finally:
            os.remove(spec_path)
        for f in os.listdir(out):                       # the export also copies the cover in; the server only needs the songs
            if not f[:2].isdigit():
                os.remove(os.path.join(out, f))
        print(f"Download: {', '.join(sorted(os.listdir(out)))}")
    else:
        print("Download: already up to date")

    # 3 · the cover, if the app has one for the demo
    for e in ("png", "jpg"):
        old = os.path.join(PUBLIC, f"cover.{e}")
        if os.path.exists(old):
            os.remove(old)
    src = next((p for p in (os.path.join(STATE, "covers", f"{DEMO}.{e}") for e in ("png", "jpg")) if os.path.exists(p)), None)
    if src:
        shutil.copyfile(src, os.path.join(PUBLIC, "cover" + os.path.splitext(src)[1]))

    size = sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in os.walk(PUBLIC) for f in fs)
    print(f"Done: {PUBLIC} ({size / 1e6:.0f} MB)")


if __name__ == "__main__":
    main(force="--force" in sys.argv)
