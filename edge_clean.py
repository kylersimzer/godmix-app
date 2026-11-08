"""Automatic start/end clean-up for album originals (a static burst at the very start of a file, and clicks at the end).

Safeguards:
  * It only CUTS when the start looks exactly like that burst:
      - sound begins at the very first millisecond,
      - it is short (at most 60 ms) and not loud (at most -18 dBFS),
      - it is followed by at least 50 ms of near-silence before the music.
    The cut is made inside that silence, never in the music.
  * Anything that is close but doesn't match every rule is FLAGGED for a human, not cut.
  * Otherwise it only adds tiny fades: 3 ms in if the file starts on a loud sample,
    5 ms out if it ends on one. Those remove clicks without changing the sound.
  * The untouched file is always backed up first, to Originals Backup.
  * Every action is logged to edge_clean_log.json (the GODMIX app shows it), and a file it has
    already cleaned (same size and date) is skipped.

Usage: python edge_clean.py [--dry-run] [--album DIR] [name fragments...]
"""
import sys, os, re, glob, json, shutil, datetime
import numpy as np, soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
LOG = os.environ.get("EDGE_CLEAN_LOG") or os.path.join(HERE, "edge_clean_log.json")

# detection rules
ACTIVE_DB = -60      # the first millisecond is louder than this -> something is there
SILENT_DB = -68      # "near-silence" (the files' background noise sits around -75 to -85)
SILENT_RUN_MS = 10   # this long below SILENT_DB counts as the burst having ended
MUSIC_DB = -60       # first millisecond above this after the silence = music onset
MAX_BURST_MS = 60
MAX_BURST_DB = -18
MIN_GAP_MS = 50
FADE_IN_MS, CUT_FADE_MS, FADE_OUT_MS = 3, 2, 5


def _dtype(subtype):
    return {"PCM_16": "int16", "PCM_24": "int32", "PCM_32": "int32"}.get(subtype, "float64")


def _full_scale(dtype):
    return {"int16": 32768.0, "int32": 2147483648.0}.get(dtype, 1.0)


def analyze(x, fs, fullscale):
    """Return the plan for one file: what to cut/fade and why."""
    ms = fs // 1000
    a = np.abs(x.astype(np.float64)).max(axis=1) / fullscale
    n = len(a) // ms
    pk = 20 * np.log10(a[: n * ms].reshape(n, ms).max(axis=1) + 1e-12)
    db = lambda v: float(20 * np.log10(v + 1e-12))
    plan = dict(cut_samples=0, fade_in_ms=0, fade_out_ms=0, action="none", reasons=[], flag=False)

    if pk[0] > ACTIVE_DB:
        q = next((i for i in range(min(400, n - SILENT_RUN_MS)) if (pk[i:i + SILENT_RUN_MS] < SILENT_DB).all()), None)
        if q is None:
            plan["reasons"].append("music starts immediately (no silent gap), so nothing to cut")
        else:
            onset = next((i for i in range(q, n) if pk[i] > MUSIC_DB), n)
            burst_db, gap = float(pk[:q].max()), onset - q
            plan.update(burst_ms=int(q), burst_db=round(burst_db, 1), gap_ms=int(gap), music_ms=int(onset))
            problems = []
            if q > MAX_BURST_MS: problems.append(f"sound before the gap lasts {q} ms (limit {MAX_BURST_MS})")
            if burst_db > MAX_BURST_DB: problems.append(f"it is loud ({burst_db:.1f} dBFS, limit {MAX_BURST_DB})")
            if gap < MIN_GAP_MS: problems.append(f"the silence after it is only {gap} ms (needs {MIN_GAP_MS})")
            if problems:
                plan["flag"] = True
                plan["reasons"].append("start has a sound followed by silence, but " + "; ".join(problems) +
                                       ". It might be intentional, so it was NOT cut. Listen to the first second.")
            else:
                # quietest 2 ms in the first 30 ms of the silence (never near the music)
                lo, hi, w, hop = q * ms, min(q + 30, onset - 20) * ms, 2 * ms, max(1, ms // 4)
                win = [a[i:i + w].max() for i in range(lo, max(lo + 1, hi - w), hop)]
                cut = lo + int(np.argmin(win)) * hop
                plan.update(cut_samples=int(cut), action="cut")
                plan["reasons"].append(f"cut {cut / fs * 1000:.1f} ms of start static (peaked {burst_db:.1f} dBFS, "
                                       f"lasted {q} ms); music now starts at {(onset * ms - cut) / fs * 1000:.0f} ms")
    first = a[plan["cut_samples"]]
    if plan["action"] == "cut":
        plan["fade_in_ms"] = CUT_FADE_MS
    elif db(first) > -70:
        plan["fade_in_ms"] = FADE_IN_MS
        plan["reasons"].append(f"3 ms fade-in (first sample was {db(first):.1f} dBFS)")
        plan["action"] = "fade" if plan["action"] == "none" else plan["action"]
    last = a[-1]
    if db(last) > -85:
        plan["fade_out_ms"] = FADE_OUT_MS
        plan["reasons"].append(f"5 ms fade-out (last sample was {db(last):.1f} dBFS)")
        if plan["action"] == "none": plan["action"] = "fade"
    if plan["flag"]: plan["action"] = "flag" if plan["action"] == "none" else plan["action"] + "+flag"
    return plan


def apply(x, fs, plan):
    y = x[plan["cut_samples"]:].astype(np.float64)
    fi, fo = int(fs * plan["fade_in_ms"] / 1000), int(fs * plan["fade_out_ms"] / 1000)
    if fi: y[:fi] *= np.sin(np.linspace(0, np.pi / 2, fi))[:, None] ** 2
    if fo: y[-fo:] *= np.cos(np.linspace(0, np.pi / 2, fo))[:, None] ** 2
    return y


def _sig(path):
    s = os.stat(path)
    return [s.st_size, int(s.st_mtime)]


def load_log():
    return json.load(open(LOG)) if os.path.exists(LOG) else {}


def clean(path, dry_run=False, log=None):
    """Clean one original in place (after backing it up). Returns the log entry."""
    log = load_log() if log is None else log
    name = os.path.basename(path)
    prev = log.get(name)
    if not prev:
        # the file may just have been renumbered ("7. Song…" -> "6. Song…"): carry its record over by title
        title = re.sub(r"^\d+\.\s*", "", name[:-4])
        for k in list(log):
            if re.sub(r"^\d+\.\s*", "", k[:-4]) == title and not os.path.exists(os.path.join(os.path.dirname(path), k)):
                prev = log.pop(k)
                prev["file"] = name
                log[name] = prev
                if not dry_run:
                    json.dump(log, open(LOG, "w"), indent=1)
                break
    if prev and prev.get("sig") == _sig(path):
        return dict(prev, skipped=True)
    info = sf.info(path)
    dtype = _dtype(info.subtype)
    x, fs = sf.read(path, dtype=dtype, always_2d=True)
    plan = analyze(x, fs, _full_scale(dtype))
    entry = dict(plan, file=name, when=datetime.datetime.now().isoformat(timespec="seconds"), backup=None)
    # keep earlier clean-ups of this track (from before the file was replaced or edited)
    entry["history"] = list(prev.get("history", [])) if prev else []
    if prev and prev.get("action") not in (None, "none"):
        entry["history"].append({k: prev.get(k) for k in ("when", "action", "reasons", "backup")})
    if plan["action"] == "none":
        entry["reasons"] = ["clean already, nothing to do"]
    if dry_run:
        return entry
    if plan["cut_samples"] or plan["fade_in_ms"] or plan["fade_out_ms"]:
        bdir = os.path.join(os.path.dirname(path), "Originals Backup")
        os.makedirs(bdir, exist_ok=True)
        stamp = datetime.datetime.now().strftime("%Y-%m-%d %H%M")
        backup = os.path.join(bdir, f"{name[:-4]} (before auto clean {stamp}).wav")
        shutil.copy2(path, backup)
        y = apply(x, fs, plan)
        if dtype != "float64":
            y = np.round(y).astype(dtype)
        # untouched middle must be bit-identical
        mid = slice(int(fs * plan["fade_in_ms"] / 1000), len(y) - int(fs * plan["fade_out_ms"] / 1000))
        assert (y[mid] == x[plan["cut_samples"]:][mid]).all()
        sf.write(path, y, fs, subtype=info.subtype)
        entry["backup"] = os.path.basename(backup)
    entry["sig"] = _sig(path)
    log[name] = entry
    json.dump(log, open(LOG, "w"), indent=1)
    return entry


def describe(e):
    tag = {"cut": "CUT ", "fade": "FADE", "none": "ok  ", "flag": "FLAG"}.get(e["action"].split("+")[0], "    ")
    if "flag" in e["action"]: tag = "FLAG"
    if e.get("skipped"):
        if "flag" in e["action"]:
            return f"[FLAG] {e['file'][:26]:26s} still flagged from an earlier check: " + e["reasons"][0]
        tag = "skip"
    return f"[{tag}] {e['file'][:26]:26s} " + ("already cleaned earlier" if e.get("skipped") else " | ".join(e["reasons"]))


def pick(files, picks):
    """Filter files by track number ("2") or whole words of the title ("love", "night drive")."""
    if not picks:
        return files
    def hit(f, s):
        base = os.path.basename(f)
        if s.isdigit():
            return base.split(".")[0] == s
        return re.search(r"\b" + re.escape(s) + r"\b", base, re.IGNORECASE) is not None
    return [f for f in files if any(hit(f, s) for s in picks)]


def clean_album(album, fragments=(), dry_run=False):
    files = pick(sorted(glob.glob(os.path.join(album, "*.wav"))), fragments)
    log = load_log()
    out = [clean(f, dry_run, log) for f in files]
    for e in out:
        print(describe(e))
    flagged = [e for e in out if "flag" in e["action"]]
    if flagged:
        print(f"\n!! {len(flagged)} file(s) flagged for you to check by ear (nothing was cut there):")
        for e in flagged: print("   -", e["file"])
    return out


if __name__ == "__main__":
    args = sys.argv[1:]
    dry = "--dry-run" in args
    import albums
    album = None
    if "--album" in args:
        album = args[args.index("--album") + 1]
    frags = [a for i, a in enumerate(args) if not a.startswith("--") and (i == 0 or args[i - 1] != "--album")]
    clean_album(album or albums.master_folder(), frags, dry)
