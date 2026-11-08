"""Mastering helpers: BS.1770 loudness, true peak, and a limiter -> clipper -> limiter chain."""
import os
import numpy as np
import soundfile as sf
from scipy import signal
from numba import njit

OS = 4  # oversampling factor for true-peak detection and clipping


# ---------------------------------------------------------------- loudness
def _biquad(kind, G, Q, fc, fs):
    A = 10 ** (G / 40.0)
    w0 = 2 * np.pi * fc / fs
    alpha = np.sin(w0) / (2 * Q)
    c = np.cos(w0)
    if kind == "high_shelf":
        b = [A * ((A + 1) + (A - 1) * c + 2 * np.sqrt(A) * alpha),
             -2 * A * ((A - 1) + (A + 1) * c),
             A * ((A + 1) + (A - 1) * c - 2 * np.sqrt(A) * alpha)]
        a = [(A + 1) - (A - 1) * c + 2 * np.sqrt(A) * alpha,
             2 * ((A - 1) - (A + 1) * c),
             (A + 1) - (A - 1) * c - 2 * np.sqrt(A) * alpha]
    else:  # high_pass
        b = [(1 + c) / 2, -(1 + c), (1 + c) / 2]
        a = [1 + alpha, -2 * c, 1 - alpha]
    b, a = np.array(b) / a[0], np.array(a) / a[0]
    return b, a


def kweight(x, fs):
    b1, a1 = _biquad("high_shelf", 3.99984385397, 0.7071752369554193, 1681.9744509555319, fs)
    b2, a2 = _biquad("high_pass", 0.0, 0.5003270373253953, 38.13547087613982, fs)
    y = signal.lfilter(b1, a1, x, axis=0)
    return signal.lfilter(b2, a2, y, axis=0)


def _window_power(xk, fs, win_s, hop_s):
    """Mean-square (summed over channels) for sliding windows."""
    p = np.sum(xk.astype(np.float64) ** 2, axis=1)
    cs = np.concatenate([[0.0], np.cumsum(p)])
    w, h = int(round(win_s * fs)), int(round(hop_s * fs))
    starts = np.arange(0, len(p) - w + 1, h)
    return (cs[starts + w] - cs[starts]) / w


def _lufs(ms):
    return -0.691 + 10 * np.log10(np.maximum(ms, 1e-20))


def integrated(x, fs, xk=None):
    xk = kweight(x, fs) if xk is None else xk
    ms = _window_power(xk, fs, 0.4, 0.1)
    l = _lufs(ms)
    ms = ms[l > -70]
    rel = _lufs(ms.mean()) - 10
    ms = ms[_lufs(ms) > rel]
    return float(_lufs(ms.mean()))


def short_term(x, fs, xk=None, hop=0.1):
    xk = kweight(x, fs) if xk is None else xk
    return _lufs(_window_power(xk, fs, 3.0, hop))


def lra(st):
    s = st[st > -70]
    s = s[s > _lufs(np.mean(10 ** ((s + 0.691) / 10))) - 20]
    return float(np.percentile(s, 95) - np.percentile(s, 10))


def loud_section(st):
    """Loudness of the loud parts: power-mean of the top 20% of short-term windows."""
    s = np.sort(st[st > -70])
    top = s[int(len(s) * 0.8):]
    return float(_lufs(np.mean(10 ** ((top + 0.691) / 10))))


def oversample(x, up=OS):
    return signal.resample_poly(x, up, 1, axis=0)


def downsample(x, down=OS):
    return signal.resample_poly(x, 1, down, axis=0)


def true_peak_db(x):
    return float(20 * np.log10(np.max(np.abs(oversample(x))) + 1e-20))


def measure(x, fs):
    xk = kweight(x, fs)
    st = short_term(x, fs, xk)
    return dict(I=integrated(x, fs, xk), loud=loud_section(st), LRA=lra(st),
                stmax=float(st.max()), TP=true_peak_db(x),
                SP=float(20 * np.log10(np.max(np.abs(x)) + 1e-20)))


# ---------------------------------------------------------------- dynamics
@njit(cache=True)
def _hold_release(req_gr, hold, rel_coef):
    """req_gr: required gain reduction (dB, >=0) per sample.
    Forward max-hold over `hold` samples, then exponential release (dB domain)."""
    n = len(req_gr)
    held = np.empty(n)
    # sliding max over [i, i+hold-1] via monotonic deque
    dq = np.empty(n, dtype=np.int64)
    head = 0
    tail = 0
    j = 0
    for i in range(n):
        while j < n and j <= i + hold - 1:
            while tail > head and req_gr[dq[tail - 1]] <= req_gr[j]:
                tail -= 1
            dq[tail] = j
            tail += 1
            j += 1
        while dq[head] < i:
            head += 1
        held[i] = req_gr[dq[head]]
    out = np.empty(n)
    prev = 0.0
    for i in range(n):
        r = prev * rel_coef
        prev = held[i] if held[i] > r else r
        out[i] = prev
    return out


def _box(x, L):
    if L <= 1:
        return x
    c = np.concatenate([np.zeros(L), np.cumsum(x)])
    return (c[L:] - c[:-L]) / L


def limiter(x, fs, ceiling_db, lookahead_ms=3.0, release_ms=120.0):
    """Linked-stereo, true-peak-aware lookahead limiter. Returns (y, gr_db)."""
    xu = np.abs(oversample(x)).max(axis=1)
    # peak per base sample from the oversampled signal (covering intersample peaks)
    n = x.shape[0]
    xu = xu[: n * OS].reshape(n, OS).max(axis=1)
    xu = np.maximum(xu, np.abs(x).max(axis=1))
    c = 10 ** (ceiling_db / 20)
    req = np.maximum(0.0, 20 * np.log10(np.maximum(xu, 1e-12) / c))
    L = max(2, int(round(lookahead_ms * fs / 1000)))
    rel = np.exp(-1.0 / (release_ms * fs / 1000))
    gr = _hold_release(req, L, rel)
    h = L // 2
    gr = _box(_box(gr, h), L - h + 1)
    g = 10 ** (-gr / 20)
    return x * g[:, None], gr


def soft_clip(x, ceiling_db, knee_db=1.5):
    """Oversampled soft clipper: linear below ceiling-knee, tanh into the ceiling."""
    C = 10 ** (ceiling_db / 20)
    T = C * 10 ** (-knee_db / 20)
    xu = oversample(x)
    a = np.abs(xu)
    over = a > T
    y = xu.copy()
    y[over] = np.sign(xu[over]) * (T + (C - T) * np.tanh((a[over] - T) / (C - T)))
    return downsample(y)[: x.shape[0]]


def highpass(x, fs, fc=20.0):
    sos = signal.butter(2, fc, "highpass", fs=fs, output="sos")
    return signal.sosfilt(sos, x, axis=0)


def chain(x, fs, gain_db, ceiling_db=-1.0, clip_db=1.5,
          la_ms=3.0, rel_ms=120.0):
    """gain -> stage-1 limiter (ceiling + clip_db) -> soft clipper -> final TP limiter."""
    y = x * 10 ** (gain_db / 20)
    y, gr1 = limiter(y, fs, ceiling_db + clip_db, la_ms, rel_ms)
    pre_clip = y
    y = soft_clip(y, ceiling_db + 0.2, knee_db=clip_db + 0.2) if clip_db > 0 else y
    clip_res = y - pre_clip
    y, gr2 = limiter(y, fs, ceiling_db - 0.05, 1.0, 40.0)
    return y, dict(gr1=gr1, gr2=gr2, clip_res=clip_res)


MASTER_LABELS = {"hi": "24-bit 48kHz", "cd": "16-bit 44.1kHz"}


def master_filename(name, kind="hi"):
    """'2. Song.wav' -> '2. Song 24-bit 48kHz.wav' (kind 'hi') or '2. Song 16-bit 44.1kHz.wav' (kind 'cd')."""
    return f"{os.path.splitext(name)[0]} {MASTER_LABELS[kind]}.wav"


def edge_fades(x, fs, in_ms=1.0, out_ms=5.0):
    """Tiny fades so the file starts and ends on silence (filters in the chain leave small tails)."""
    y = x.copy()
    fi, fo = int(fs * in_ms / 1000), int(fs * out_ms / 1000)
    y[:fi] *= np.sin(np.linspace(0, np.pi / 2, fi))[:, None] ** 2
    y[-fo:] *= np.cos(np.linspace(0, np.pi / 2, fo))[:, None] ** 2
    return y


def tpdf_dither_quantize(x, bits):
    q = 2.0 ** (bits - 1)
    rng = np.random.default_rng(333)
    d = (rng.random(x.shape) - rng.random(x.shape)) / q
    return np.clip(np.round((x + d) * q) / q, -1, 1 - 1 / q)


def load(path):
    x, fs = sf.read(path, dtype="float64", always_2d=True)
    return x, fs
