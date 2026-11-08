"""Trace Tags: demo copies you can trace.

Every copy of a song gets a spoken tag dropped over it at irregular times, nudged onto loud moments, with a small
pitch, pan and level change each time and the music dipped under it. The times come from the recipient's name and
this install's secret key, so every copy is different from the first tag on. Each copy is written down in the
ledger (app/state/trace-tags.json), and `identify` matches a leaked file back to the copy it came from.

  python trace_tags.py speak "Demo. Not for release." out.wav [male|female]   typed words → a spoken tag
  python trace_tags.py identify leak.mp3                                       whose copy is this?

Making copies runs through app/jobs.py trace (the app's Trace Tags menu). The voice is the computer's own: Windows
speech, macOS `say`, or espeak on Linux. Recorded tags (WAV, FLAC, AIFF or MP3) live in app/state/trace-clips.
"""
import os, sys, json, hashlib, secrets, subprocess, shutil, tempfile, datetime
from fractions import Fraction
import numpy as np
import soundfile as sf
from scipy import signal
from pedalboard import Pedalboard, Reverb, HighpassFilter, PeakFilter
import mlib

ROOT = os.path.dirname(os.path.abspath(__file__))
STATE = os.environ.get("GODMIX_STATE_DIR") or os.path.join(ROOT, "app", "state")
CLIPS = os.path.join(STATE, "trace-clips")
LEDGER = os.path.join(STATE, "trace-tags.json")
KEY = os.path.join(STATE, "trace-key.txt")

DENSITY = {"light": (16.0, 24.0), "normal": (8.0, 15.0), "heavy": (5.0, 9.0)}   # seconds from one tag to the next
NUDGE = 0.6          # each tag moves up to this far onto the loudest nearby moment
DUCK_DB = 3.0        # the music dips this much under a tag
TAG_OVER_DB = 1.0    # a tag's level against the music around it
PITCH_ST, PAN, LEVEL_DB = 1.0, 0.45, 1.5     # ± per tag
NAME_SHARE = 0.35    # with "say their name", about this share of the tags are the name


# ─────────────────────────────────────────────── voices
def speak(text, out, voice="male"):
    """Typed words → a WAV, with the computer's own voice. Raises if there's no voice to use."""
    text = " ".join(str(text).split())[:200]
    if not text:
        raise ValueError("Nothing to say")
    if sys.platform == "win32":
        ps = ("Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
              f"$s.SelectVoiceByHints([System.Speech.Synthesis.VoiceGender]::{'Female' if voice == 'female' else 'Male'}); $s.Rate = -1; "
              "$s.SetOutputToWaveFile($env:GODMIX_OUT); $s.Speak($env:GODMIX_SAY); $s.Dispose()")
        subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps], check=True, capture_output=True,
                       env={**os.environ, "GODMIX_SAY": text, "GODMIX_OUT": out})
    elif sys.platform == "darwin":
        subprocess.run(["say", "-o", out, "--file-format=WAVE", "--data-format=LEI16@22050", "--", text], check=True, capture_output=True)
    else:
        exe = shutil.which("espeak-ng") or shutil.which("espeak")
        if not exe:
            raise RuntimeError("No speech voice on this computer (install espeak-ng), or use a recorded tag")
        subprocess.run([exe, "-v", "en-us+m3" if voice != "female" else "en-us+f3", "-s", "150", "-w", out, "--", text], check=True, capture_output=True)
    if not os.path.exists(out) or os.path.getsize(out) < 1000:
        raise RuntimeError("The computer's voice didn't produce any audio")
    return out


def resample(x, fs_in, fs_out):
    if fs_in == fs_out:
        return x
    r = Fraction(int(fs_out), int(fs_in)).limit_denominator(1000)
    return signal.resample_poly(x, r.numerator, r.denominator, axis=0)


def prep_clip(path, fs):
    """A tag clip ready to drop in: mono, trimmed, cleaned up, peaks tamed, at unit RMS."""
    t, tfs = sf.read(path, dtype="float64", always_2d=True)
    t = t.mean(axis=1)
    if not np.abs(t).max() > 0:
        raise ValueError(f"{os.path.basename(path)} is silent")
    on = np.flatnonzero(np.abs(t) > 0.02 * np.abs(t).max())
    t = t[max(0, on[0] - int(0.02 * tfs)): on[-1] + int(0.08 * tfs)][: int(8 * tfs)]     # 8 s at most
    t = resample(t, tfs, fs)
    t = np.concatenate([t, np.zeros(int(0.35 * fs))])
    board = Pedalboard([HighpassFilter(160), PeakFilter(3000, 2.5, 0.8),
                        Reverb(room_size=0.25, damping=0.6, wet_level=0.12, dry_level=0.9, width=0.0)])
    t = board(t.astype(np.float32)[None, :], fs)[0].astype(np.float64)
    t /= np.abs(t).max()
    t = np.tanh(3.0 * t) / np.tanh(3.0)                 # speech peaks would otherwise hit the limiter
    return t / (np.sqrt(np.mean(t ** 2)) + 1e-12)


# ─────────────────────────────────────────────── where the tags go
def secret_key():
    """This install's secret: without it nobody can work out where another copy's tags are."""
    if not os.path.exists(KEY):
        os.makedirs(STATE, exist_ok=True)
        open(KEY, "w").write(secrets.token_hex(16))
    return open(KEY).read().strip()


def loudness_track(x, fs, hop=0.05):
    blk = int(fs * hop)
    n = len(x) // blk
    m = x[: n * blk].mean(axis=1).reshape(n, blk)
    return np.sqrt(np.mean(m ** 2, axis=1) + 1e-12), blk


def make_plan(seed_text, dur, lvl, blk, fs, clips, density="normal"):
    """clips: [{"len": seconds, "name": bool}]. Returns [{t, clip, len, st, pan, db}] from a seed only this copy has."""
    rng = np.random.default_rng(int.from_bytes(hashlib.sha256(seed_text.encode()).digest()[:8], "big"))
    gap = DENSITY.get(density, DENSITY["normal"])
    smooth = np.convolve(lvl, np.ones(5) / 5, "same")                    # 0.25 s average
    names = [i for i, c in enumerate(clips) if c.get("name")]
    words = [i for i, c in enumerate(clips) if not c.get("name")] or names
    plan, t = [], rng.uniform(1.5, 5.0)
    while True:
        k = int(rng.choice(names)) if names and rng.random() < NAME_SHARE else int(rng.choice(words))
        L = clips[k]["len"]
        if t + L > dur - 1.5:
            break
        lo, hi = max(0, int((t - NUDGE) * fs / blk)), min(len(lvl) - 1, int((t + NUDGE) * fs / blk))
        at = (lo + int(np.argmax(smooth[lo:hi]))) * blk / fs if hi > lo else t
        if plan and at < plan[-1]["t"] + plan[-1]["len"] + 1.0:          # never overlapping the last one
            at = plan[-1]["t"] + plan[-1]["len"] + 1.0
        plan.append(dict(t=round(at, 3), clip=k, len=round(L, 3), st=round(float(rng.uniform(-PITCH_ST, PITCH_ST)), 2),
                         pan=round(float(rng.uniform(-PAN, PAN)), 2), db=round(float(rng.uniform(-LEVEL_DB, LEVEL_DB)), 2)))
        t = at + rng.uniform(*gap)
    return plan


def render(x, fs, clips, plan, lvl, blk):
    """The song with its tags in, the music dipped under each one; true peak held at -1 dBTP."""
    voice, duck = np.zeros_like(x), np.zeros(len(x))
    for p in plan:
        k = resample(clips[p["clip"]]["audio"], fs, int(round(fs / 2 ** (p["st"] / 12))))   # pitch by speed
        i = int(p["t"] * fs)
        k = k[: max(0, len(x) - i)]
        a, b = int(p["t"] * fs / blk), int((p["t"] + len(k) / fs) * fs / blk)
        local = np.sqrt(np.mean(lvl[a:b] ** 2)) if b > a else lvl.mean()
        g = local * 10 ** ((TAG_OVER_DB + p["db"]) / 20)
        th = (p["pan"] + 1) * np.pi / 4
        voice[i:i + len(k), 0] += k * g * np.cos(th) * np.sqrt(2)
        voice[i:i + len(k), 1] += k * g * np.sin(th) * np.sqrt(2)
        duck[i:i + len(k)] = 1.0
    w = int(0.04 * fs)
    sm = np.convolve(duck, np.ones(w) / w, "same")
    rel = np.exp(-1 / (0.25 * fs))
    env = np.maximum(sm, signal.lfilter([1 - rel], [1, -rel], sm))
    y = x * 10 ** (-DUCK_DB * np.clip(env, 0, 1) / 20)[:, None] + voice
    y, _ = mlib.chain(y, fs, 0.0, ceiling_db=-1.0, clip_db=1.5)
    return y


# ─────────────────────────────────────────────── the ledger
def read_ledger():
    try:
        return json.load(open(LEDGER, encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        return {"copies": []}


def add_to_ledger(entries):
    led = read_ledger()
    led["copies"].extend(entries)
    os.makedirs(STATE, exist_ok=True)
    tmp = LEDGER + ".tmp"
    json.dump(led, open(tmp, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    os.replace(tmp, LEDGER)


# ─────────────────────────────────────────────── identify a leak
SR = 16000


def find_ffmpeg():
    import glob
    cands = [os.environ.get("GODMIX_FFMPEG"), shutil.which("ffmpeg")]
    if os.environ.get("LOCALAPPDATA"):
        cands += glob.glob(os.path.join(os.environ["LOCALAPPDATA"], "Microsoft", "WinGet", "Packages", "*FFmpeg*", "**", "bin", "ffmpeg.exe"), recursive=True)
    return next((c for c in cands if c and os.path.exists(c)), None)


def _mono16(path):
    """Any audio file as mono at 16 kHz (soundfile reads WAV, FLAC, AIFF, MP3; ffmpeg does the rest, like M4A)."""
    try:
        x, fs = sf.read(path, dtype="float64", always_2d=True)
    except Exception:
        ff = find_ffmpeg()
        if not ff:
            raise ValueError("Can't read that file (install ffmpeg for M4A/AAC)")
        out = subprocess.run([ff, "-v", "error", "-i", path, "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"], check=True, capture_output=True).stdout
        return np.frombuffer(out, dtype=np.float32).astype(np.float64)
    return resample(x.mean(axis=1), fs, SR)


def _env(x, hop=160):
    n = len(x) // hop
    return np.log10(np.sqrt(np.mean(x[: n * hop].reshape(n, hop) ** 2, axis=1)) + 1e-6)


def _align(leak, src):
    """Where the leak starts in the source, in samples at 16 kHz, and how well the two match (0–1)."""
    a, b = _env(leak), _env(src)
    a, b = a - a.mean(), b - b.mean()
    c = signal.fftconvolve(b, a[::-1], mode="full")
    lag = int(np.argmax(c)) - (len(a) - 1)                 # frames: leak[0] sits at src[lag]
    o0, o1 = max(0, lag), min(len(b), lag + len(a))
    if o1 - o0 < 200:
        return 0, 0.0
    sa, sb = a[o0 - lag: o1 - lag], b[o0:o1]
    score = float(np.corrcoef(sa, sb)[0, 1])
    # to the sample: 8 s from the middle of the overlap, searched ±20 ms around the rough lag
    w, pad = 8 * SR, 320
    ls = ((o0 + o1) // 2 - lag) * 160 - w // 2
    pos = ls + lag * 160
    seg, ref = leak[max(0, ls): max(0, ls) + w], src[max(0, pos - pad): pos + w + pad]
    start = lag * 160
    if ls >= 0 and pos - pad >= 0 and len(seg) == w and len(ref) == w + 2 * pad:
        cc = signal.fftconvolve(ref, seg[::-1], mode="valid")
        start = pos - pad + int(np.argmax(cc)) - ls
    return start, score


def _added(leak, src, start):
    """How much sound the leak has that the source doesn't, frame by frame (16 ms), in the tag's range."""
    n, hop = 1024, 256
    if start >= 0:
        s, l = src[start:], leak
    else:
        s, l = src, leak[-start:]
    m = min(len(s), len(l))
    _, _, S = signal.stft(s[:m], SR, nperseg=n, noverlap=n - hop)
    _, _, L = signal.stft(l[:m], SR, nperseg=n, noverlap=n - hop)
    band = slice(int(250 / SR * n), int(4000 / SR * n))
    S, L = np.abs(S[band]), np.abs(L[band])
    g = np.median(L.sum(0)) / (np.median(S.sum(0)) + 1e-12)
    ref = g * S
    # per band: what's there beyond the (dipped) music, against the music with a floor, so quiet parts don't swamp it
    d = np.log1p((np.maximum(L - 0.75 * ref, 0) / (ref + 0.3 * np.median(ref, axis=1, keepdims=True))).mean(0))
    return d - np.median(d), hop / SR, max(start, 0) / SR


def identify(path, ledger=None):
    """Score every copy in the ledger against a leaked file. Returns {verdict, best, matches[]}."""
    led = ledger or read_ledger()
    copies = [c for c in led["copies"] if os.path.exists(c.get("source", ""))]
    if not copies:
        return dict(verdict="none", msg="No Trace Tag copies on record yet", matches=[])
    leak = _mono16(path)
    sources = {}
    for c in copies:
        sources.setdefault(c["source"], []).append(c)
    fits = []
    for src_path in sources:
        src = _mono16(src_path)
        start, score = _align(leak, src)
        fits.append((score, src_path, start, src))
    fits.sort(key=lambda f: -f[0])
    score, src_path, start, src = fits[0]
    if score < 0.5:
        return dict(verdict="none", msg="That doesn't match any song with Trace Tag copies", matches=[])
    d, frame, offset = _added(leak, src, start)
    t = offset + np.arange(len(d)) * frame
    matches = []
    for c in sources[src_path]:
        ind = np.zeros(len(d))
        for p in c["plan"]:
            ind[(t >= p["t"] + 0.05) & (t < p["t"] + p["len"] - 0.3)] = 1.0
        r = float(np.corrcoef(d, ind)[0, 1]) if ind.any() and ind.std() > 0 else 0.0
        matches.append(dict(id=c["id"], recipient=c["recipient"], title=c["title"], version=c.get("version", ""),
                            made=c["made"], score=round(r, 3)))
    matches.sort(key=lambda m: -m["score"])
    best = matches[0]
    second = matches[1]["score"] if len(matches) > 1 else 0.0
    sure = best["score"] > 0.25 and best["score"] - second > 0.12
    if best["score"] < 0.15:
        return dict(verdict="none", song_fit=round(score, 3), matches=matches[:8],
                    msg=f"It’s {best['title']}, but none of your Trace Tag copies: maybe the untagged song, or tags from somewhere else")
    return dict(verdict="match" if sure else "unsure", best=best, song_fit=round(score, 3), matches=matches[:8],
                msg=(f"This is {best['recipient']}’s copy of {best['title']}" if sure else
                     f"Closest is {best['recipient']}’s copy of {best['title']}, but it isn’t a clear match"))


if __name__ == "__main__":
    a = sys.argv[1:]
    if a[:1] == ["speak"] and len(a) >= 3:
        print(speak(a[1], a[2], a[3] if len(a) > 3 else "male"))
    elif a[:1] == ["identify"] and len(a) == 2:
        print(json.dumps(identify(a[1]), indent=1, ensure_ascii=False))
    else:
        print(__doc__); sys.exit(2)
