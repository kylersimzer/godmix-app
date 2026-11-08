"""Album registry (albums.json): where each album lives, its official titles/order, and file paths.

Released albums are READ-ONLY: their files are the released masters. Tools only read them and write new
files under <album>/Versions. An album still being mastered here has "masters" set (originals + Mastered/).

Each track has:
  id      the source filename (unique key used everywhere, e.g. the GODMIX app's saved state)
  n       official track number          title  official title
  stem    "<n>. <title>"  - the base for version filenames, e.g. "7. Find You (Slowed + Reverb) 24-bit 48kHz.wav"
  src     the file versions are made from (being mastered: the cleaned original; released: the album file)
  master  the album-quality file to compare against (being mastered: Mastered/...; released: the album file itself)

Album fields: id, title (e.g. "000"), year (optional), and per track an optional isrc; subtitle (optional, usually empty), artist (optional; shown as "by …"), folder
(absolute, or relative to this repo), released, demo, masters (only on an album being mastered), tracks (a list, or "from-files").
save_registry() writes the registry back in its hand-written compact style, so app edits make small diffs.

Your own albums live outside the code, in local/ (ignored by git; GODMIX_LOCAL moves it):
  local/albums.json        your albums (albums.json in the repo holds only the demo)
  local/versions_cfg.json  your albums' version settings (merged over versions_cfg.json)
  local/render_cfg.json    your mastering settings (merged over render_cfg.json)
  local/plans/<id>.json    version-design measurements (yours, and the demo's once you change them)
  local/settings.json      optional: {"bpm_config": "<a stems.fm config with official BPMs>"}
New albums added from the app go to local/albums.json; the demo stays in albums.json.
"""
import os, re, json, glob

HERE = os.path.dirname(os.path.abspath(__file__))
LOCAL = os.environ.get("GODMIX_LOCAL") or os.path.join(HERE, "local")


def local_path(*parts):
    return os.path.join(LOCAL, *parts)


def _json(path, default):
    return json.load(open(path, encoding="utf-8")) if os.path.exists(path) else default


def _deep(base, over):
    out = dict(base)
    for k, v in over.items():
        out[k] = _deep(base[k], v) if isinstance(v, dict) and isinstance(base.get(k), dict) else v
    return out


def layered(name):
    """A settings file from the repo with your own copy in local/ merged over it (render_cfg.json)."""
    return _deep(_json(os.path.join(HERE, name), {}), _json(local_path(name), {}))


def settings():
    return _json(local_path("settings.json"), {})


_SHARED = _json(os.path.join(HERE, "albums.json"), {"albums": []})["albums"]
SHARED_IDS = {a["id"] for a in _SHARED}          # the albums that ship with the code (the demo)
REG = {"albums": _SHARED + [a for a in _json(local_path("albums.json"), {"albums": []})["albums"] if a["id"] not in SHARED_IDS]}


def plan_path(aid, write=False):
    """An album's version-design plan. Writes always go to local/plans/<id>.json; reads use that, or for the demo
    the copy shipped in plans/ until you've made your own."""
    mine = local_path("plans", f"{aid}.json")
    if write or aid not in SHARED_IDS or os.path.exists(mine):
        return mine
    return os.path.join(HERE, "plans", f"{aid}.json")


def default_id():
    """The album scripts use when no --album is given: the one being mastered, else the demo."""
    return next((a["id"] for a in REG["albums"] if a.get("masters")), "demo")


def master_folder(aid=None):
    """The folder of the album being mastered here (the one with "masters" set), or of the album named."""
    if aid:
        return album(aid)["folder"]
    a = next((x for x in REG["albums"] if x.get("masters")), None)
    if not a:
        raise SystemExit('No album to master: add "masters": "Mastered" to one album in local/albums.json')
    return album(a["id"])["folder"]
LABEL_HI = "24-bit 48kHz"
AUDIO = (".wav", ".flac", ".aif", ".aiff")


def song_title(name):
    """'6. Song Name (Final Mix).wav' -> 'Song Name': no track number, no trailing tag.
    Tags like (Final Mix) stay in filenames but don't change which song's settings apply."""
    stem = re.sub(r"\.(wav|flac|aiff?)$", "", name, flags=re.IGNORECASE)
    return re.sub(r"\s*\([^()]*\)$", "", re.sub(r"^\d+\.\s*", "", stem)).strip()


def _safe(s):
    return re.sub(r'[\\/:*?"<>|]', "", s)          # characters Windows won't allow in filenames


def album(aid):
    a = next(x for x in REG["albums"] if x["id"] == aid)
    a = dict(a)
    # a relative folder (the demo album: "demo/000") is relative to this repo
    folder = a["folder"] = a["folder"] if os.path.isabs(a["folder"]) else os.path.normpath(os.path.join(HERE, a["folder"]))
    if a["tracks"] == "from-files":
        files = sorted(glob.glob(os.path.join(folder, "*.wav")), key=lambda s: int(os.path.basename(s).split(".")[0]))
        tracks = []
        for p in files:
            f = os.path.basename(p)
            n, title = int(f.split(".")[0]), song_title(f)
            tracks.append(dict(id=f, n=n, title=title, stem=f[:-4], src=p,
                               master=os.path.join(folder, a["masters"], f"{f[:-4]} {LABEL_HI}.wav")))
    else:
        tracks = [dict(id=t["file"], n=t["n"], title=t["title"], stem=_safe(f"{t['n']}. {t['title']}"),
                       src=os.path.join(folder, t["file"]), master=os.path.join(folder, t["file"]))
                  for t in sorted(a["tracks"], key=lambda t: t["n"])]
    a["tracks"] = tracks
    a["versions_dir"] = os.path.join(folder, "Versions")
    return a


def all_ids():
    return [a["id"] for a in REG["albums"]]


def available_ids():
    """The albums whose folder exists on this machine (a fresh clone has only the demo)."""
    return [aid for aid in all_ids() if os.path.isdir(album(aid)["folder"])]


def track(a, pick):
    """Find a track by id or number first, then by title (case-insensitive).
    Numbers win: on O, "7" is track 7 (What She Craves), not the song titled "7" (track 6)."""
    for t in a["tracks"]:
        if pick in (t["id"], str(t["n"])):
            return t
    for t in a["tracks"]:
        if pick.lower() == t["title"].lower():
            return t
    return None


def tracks_from_folder(folder):
    """A new album's track list from the audio files in its folder: numbered files in number order, then the rest A–Z."""
    files = [f for f in os.listdir(folder) if f.lower().endswith(AUDIO) and os.path.isfile(os.path.join(folder, f))]
    num = lambda f: int(m.group(1)) if (m := re.match(r"^\s*(\d+)", f)) else 10 ** 6
    files.sort(key=lambda f: (num(f), f.lower()))
    return [{"file": f, "n": i + 1, "title": song_title(f)} for i, f in enumerate(files)]


def save_registry(reg=None):
    """Write the registry in its compact style: the demo to albums.json, your albums to local/albums.json."""
    reg = reg or REG
    _write([a for a in reg["albums"] if a["id"] in SHARED_IDS], os.path.join(HERE, "albums.json"))
    os.makedirs(LOCAL, exist_ok=True)
    _write([a for a in reg["albums"] if a["id"] not in SHARED_IDS], local_path("albums.json"))


def _write(albs, path):
    """One line per track, the album's own fields on a few lines."""
    J = lambda v: json.dumps(v, ensure_ascii=False)
    blocks = []
    for a in albs:
        head = [f'"id": {J(a["id"])}', f'"title": {J(a.get("title", a["id"]))}', f'"subtitle": {J(a.get("subtitle", ""))}']
        head += [f'"{k}": {J(a[k])}' for k in ("artist", "demo") if k in a]
        lines = ["      " + ", ".join(head) + ",", f'      "folder": {J(a["folder"])}, "released": {J(bool(a.get("released")))},']
        rest = [k for k in a if k not in ("id", "title", "subtitle", "artist", "demo", "folder", "released", "tracks")]
        lines += [f'      "{k}": {J(a[k])},' for k in rest]
        if isinstance(a["tracks"], list):
            rows = ",\n".join(f'        {{"file": {J(t["file"])}, "n": {J(t["n"])}, "title": {J(t["title"])}'
                               + (f', "isrc": {J(t["isrc"])}' if t.get("isrc") else "") + "}" for t in a["tracks"])
            lines.append('      "tracks": [\n' + rows + "\n      ]")
        else:
            lines.append(f'      "tracks": {J(a["tracks"])}')
        blocks.append("    {\n" + "\n".join(lines) + "\n    }")
    text = '{\n  "albums": [\n' + ",\n".join(blocks) + "\n  ]\n}\n"
    json.loads(text)
    open(path, "w", encoding="utf-8", newline="\n").write(text)
