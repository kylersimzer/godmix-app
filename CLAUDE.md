# CLAUDE.md: working in the GODMIX repo

A guide for AI coding agents (and people) changing GODMIX. Read this first, then [README.md](README.md) for what the repo does and how to set it up, and [docs/APP.md](docs/APP.md) for how the app works.

## What this is

GODMIX, by Kyler Simzer:
- **Python scripts** at the root master albums and make alternate versions.
- **The GODMIX app** (`app/`): a local web app (Node server + vanilla JS) for A/B listening, versions, running order, notes, exports and Trace Tags.
- **The brand** (`design/`): mark #136 "Three dials" from stems.fm.

The code is open source under the MIT License ([LICENSE](LICENSE)). The music (the demo album and all of Kyler Simzer's other music) and the GODMIX and stems.fm names and marks are not licensed ([NOTICE.md](NOTICE.md)).

## First time with a new user: ask before mastering

GODMIX ships with **neutral defaults** (`render_cfg.json`): a loud-section target of -10 LUFS, a -1.0 dBTP ceiling, a gentle 1.5 dB clipper, 3 ms look-ahead and 120 ms release. They are a safe middle, not anyone's sound. So before you master, design versions or tune anything for someone's album, **ask them about their music first**, then save their answers as their own settings in `local/render_cfg.json` (never edit `render_cfg.json` for one person). If `local/render_cfg.json` already exists, they've done this: use it, and only ask about what's changed.

Ask, in plain words (offer the table below when they aren't sure):
1. **What it sounds like:** genre, and two or three songs or artists whose loudness and punch they like.
2. **Where it's heard most:** streaming, club or DJ sets, SoundCloud/YouTube, radio, or phone and car speakers.
3. **Loud or open:** as loud as their genre gets, or room to breathe (dynamics) with the platforms turning it down anyway.
4. **The album's shape:** quiet intros, interludes or ballads that should stay quieter than the bangers (those become per-song `offsets`).
5. **Versions:** which they want (Slowed + Reverb, Sped Up, Other Room, Bass Boosted, Max Bass Boost), and whether any songs should be left out.

Then: write `local/render_cfg.json`, master **one** song first, let them A/B it in the app against their mix and a reference, and adjust before doing the rest. Say what you changed in numbers (target, clipper, measured LUFS and true peak).

**Starting points** (`target` is the loudness of the song's loud parts, about 1 to 2 dB louder than its overall integrated LUFS):

| Situation | `target` | `clip_db` | `la_ms` / `rel_ms` | Notes |
|---|---|---|---|---|
| Streaming-first, keep it open | -12 to -11 | 0.5 to 1 | 3 / 120 | Platforms play everything at about -14 integrated, so extra loudness just gets turned down. |
| Pop, R&B, indie | -10 to -9 | 1 to 1.5 | 3 / 120 | The default sits here. |
| Rap, trap, drill, club, EDM | -8 to -6.5 | 2 to 3 | 5 / 150 to 200 | Loud is part of the sound. More clipper keeps the 808s and kicks hard without pumping; listen for distortion on vocals. |
| Rock, metal, dense guitars | -9 to -8 | 1 to 2 | 3 / 120 | Watch cymbals and harshness (`harsh_check.py`). |
| Acoustic, jazz, classical, ambient, lo-fi | -16 to -13 | 0 | 3 / 200 | Dynamics are the point; little or no clipping. |
| Club or DJ use only | -7 to -6 | 2.5 to 3 | 5 / 150 | Matches other tracks in a set. |

- **Ceiling:** -1.0 dBTP suits nearly everything. Use -1.5 to -2.0 for very loud, bass-heavy masters that will be heavily compressed (MP3, Bluetooth); `render.py` checks peaks after encoding.
- **Per-song offsets:** `"offsets": {"Song Title": -1.5}` keeps a song quieter (or louder) than the album target, keyed by title.
- **Versions** have their own recipes in `versions_cfg.json` (shared) and per-song overrides in `local/versions_cfg.json`; ask before changing the shared recipes.

## Setup check (do this before running anything)

```bash
node --version                         # need 20+ (developed on 24)
.venv/Scripts/python --version         # Windows venv, Python 3.12; macOS/Linux: .venv/bin/python
.venv/Scripts/python -c "import numpy, scipy, soundfile, librosa, pedalboard, mutagen"   # requirements.txt
ls app/data                            # albums.json + <id>.json; if missing: python app/build_data.py (a fresh clone builds the demo)
npm test                               # server and state machine tests, need nothing installed
```

- The app has **no npm dependencies**. Don't add any; the zero-install setup is deliberate.
- Fonts (Geist, Geist Mono) load from Google Fonts. Offline, the app falls back to system fonts and still works.

## Running

- **App:** `npm start` (opens `http://localhost:8333/app`) or `node app/server.js [port]`. It only listens on, and answers, localhost.
- **Online demo:** `python app/build_public.py`, then `npm run demo` (port 8334). It's the public "Try GODMIX" copy: demo album only, read-only, notes in the browser. Anything new in the app that writes on the server or shows a path must be switched off when `DEMO` is set (app.js) and refused by the server in demo mode; `tests/demo.test.mjs` checks it.
- **After changing masters or versions:** `python app/build_data.py [album ids]`. The server re-reads data files when they change, so no restart is needed. A browser refresh shows new data.
- **Brand files:** `npm run design`. **App screenshots:** `node design/screenshot.mjs`, with the server running.

## Map

| Path | Notes |
|---|---|
| `albums.json`, `albums.py` | Album registry. `albums.json` holds only the demo; your own albums go in `local/albums.json`, merged in by `albums.py`. Albums can be added and edited from the app. Each track's id is its source filename. |
| `local/` | **Your own albums and settings, ignored by git:** `albums.json`, `versions_cfg.json`, `render_cfg.json`, `plans/`, `settings.json`. Never commit or delete it. `GODMIX_LOCAL` points the scripts at another folder. |
| `mlib.py` | Loudness (BS.1770), true peak, limiter and clipper chain, dither. Everything imports it. |
| `render.py`, `sweep.py`, `render_cfg.json` | Masters for the album with `"masters"` set. `render_cfg.json` holds defaults; your own go in `local/render_cfg.json`. |
| `version_design.py` → `versions_cfg.json` + `plans/<id>.json` | Per-song version design (speed, shelf, reverb). Per-song overrides go in `albums.<id>.overrides.<title>`: the demo's in `versions_cfg.json`, your albums' in `local/versions_cfg.json` (versions.py merges them on load and splits them on save). Plans: `plans/demo.json`, the rest in `local/plans/`. |
| `versions.py` | Renders versions into `<album folder>/Versions/{24-bit 48kHz,16-bit 44.1kHz}/`. Optional recipe keys: `speed`, `deess`, `high_shelf`, `reverb`, `mono`, `lowpass_hz`, `highpass_hz`, `tail_s`, `target_offset`, `bass` (see `bass_boost`), `target_lufs` (a fixed level instead of the song's own), `clip_db`. |
| `app/` | See docs/APP.md. `app/web/js/app.js` is the hub; `engine.js` is audio (two element pairs, one preloading); `sequence.mjs` is what happens between songs; `jobwatch.mjs` tracks jobs; `command.js` is keyboard and menus; `export.js` is the export dialog. |
| `app/jobs.py` | What the app's buttons run: `make` (design and render missing versions), `export` (tagged files and full-album renders), `album`, `trace` and `trace-check` (Trace Tags). It can also be run by hand; see its docstring. |
| `trace_tags.py` | Trace Tags: a tagged copy per person, with tag times only that copy has, and `identify` for a leaked file. The ledger (`app/state/trace-tags.json`) and the secret key (`app/state/trace-key.txt`) belong to the user: never delete or reset them. Test with `GODMIX_STATE_DIR` pointing somewhere else. See docs/APP.md. |
| `demo/000/` | The demo album (000) as FLAC, the only audio in git. **© Kyler Simzer, all rights reserved** (demo/README.md, NOTICE.md). Its versions and exports are written beside it and ignored by git. |
| `app/state/<id>.json` | The user's notes, marks, statuses and running orders. Read these to act on their feedback. Never delete or reset them. |
| `design/` | `brand.mjs` draws everything; `build.mjs` writes the files. |

## Rules

- **Released albums are read-only.** Their files are the released masters. Scripts only read them and write under `<album>/Versions`. Never edit, move or overwrite them.
- **Never commit audio** other than the demo FLACs, or `app/data`, `app/cache`, `app/state` and `local/`. Nothing about anyone's own albums (paths, track lists, settings) goes in tracked files. `.gitignore` covers them; check `git status` before committing.
- **Never change the demo audio.** Never present it as licensed for reuse; it is all rights reserved.
- **A change that alters the sound of a master or version must say so,** with before and after measurements (LUFS, true peak, tempo or tuning), and must back up the old render rather than delete it.
- **Keep the app dependency-free and fast.** Plain ES modules, no build step. Match the existing style: small helpers in `util.js`, tokens in `tokens.css`, and every shortcut listed in `SHORTCUTS`.
- **Design:** stems.fm's look (black, one off-white ink, Geist; colour only from the music or a status), finished to linear.app's standard of polish. Linear is the reference for feel only, not for features.
- **Verify in the browser:** run the app, check the console for errors, and try the feature. A deep link such as `/app#/demo/4` gets straight to a track. `godmix.state()` in the console shows every state machine at once (album phase, what's playing, what's pending between songs, live jobs); read it instead of guessing from the screen. Test with `GODMIX_STATE_DIR` pointing at a copy, never the user's own `app/state`.
- **State machines stay explicit.** Anything that changes over time gets named states and one place that moves between them (docs/APP.md, "State machines"), not a set of flags read together. Keep the logic free of page code where you can (like `sequence.mjs`), so `npm test` can drive it.

## Shortcuts for common requests

- **"Make a better slowed version of X":** find the song's override in `local/versions_cfg.json` (the demo's are in `versions_cfg.json`), change it (speed in whole semitones keeps it in tune: `2 ** (st / 12)`), render with `versions.py --album <id> --only "Slowed + Reverb" <n>`, check with `slowed_verify.py --album <id>`, then run `build_data.py <id>`. Back up the old WAVs first.
- **"Read my notes":** `app/state/<id>.json`. `marks[track]` are timestamped in song time; `status` is `work` (needs work) or `done` (approved).
