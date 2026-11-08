# The GODMIX app

A local web app for listening to an album the way a mastering room does: A/B, versions in sync, running order, transitions and notes. Node.js serves it on `127.0.0.1` only. The data it shows is built by Python from the album files.

```
albums.json + local/albums.json ──► app/build_data.py ──► app/data/<album>.json ──► app/server.js ──► browser (app/web)
 (registry: the demo + your albums)  (measures each WAV)    (+ data/albums.json)      (Node, no deps)    /  homepage
                                                                                           │            /app the app
                                                                         app/state/<album>.json ◄── notes, order, marks
```

## Files

| Path | What |
|---|---|
| `app/server.js` | HTTP server: pages, static files, album data, audio (Range), saved state, "show in folder". No dependencies. |
| `app/build_data.py` | Measures every track and version (loudness, peaks, tempo, key, loudness curve, waveform) into `app/data/`. Cached per file in `app/cache/`. Skips albums whose folder isn't on this machine. |
| `app/jobs.py` | The work the app asks for, run by the server one at a time. `make`: design missing versions (keeping hand-tuned settings), render them, refresh the data. `export`: tagged files and full-album renders. `trace` and `trace-check`: Trace Tags (below). |
| `app/web/js/export.js` | The export dialog: what to export, which version and formats, the tags, the cover, and titles and ISRCs. |
| `app/web/js/tracetags.js` | The Trace Tags menu (`R`, or **Trace Tags…** under a song's versions): the tag's words and recordings, who it's for, how often, and Check a leak. |
| `app/web/js/notepad.js` | The album's notepad (Notes button, `P`): a draggable, resizable note with named tabs. |
| `app/web/js/albumdialog.js` | Add an album from a folder, or edit an album's title, subtitle and artist. |
| `app/web/home.html` | The homepage at `/`. `js/home.js` fills it from the real album data and runs its live pieces on the demo album through `engine.js`: one engine, one widget playing at a time, 60% by default (`godmix.home.volume` in localStorage). |
| `app/cache/demo-export/` | The homepage's download (one tagged demo song per format), made by an export job on first request. Ignored by git. |
| `app/build_public.py` | Makes what the online demo serves, in `app/cache/public/`: MP3 320 copies of the demo's songs and versions, and the download. See [The online demo](#the-online-demo). |
| `app/web/index.html` | The app at `/app`: sidebar, running order, details panel and player. |
| `app/web/css/tokens.css` | Design tokens (colour, type, radii, motion), shared by the app, homepage and `design/index.html`. |
| `app/web/css/app.css`, `home.css` | Styles. |
| `app/web/js/app.js` | The app: loading, rendering, running order, undo, marks, statuses, exports, deep links, media keys. |
| `app/web/js/engine.js` | Audio engine: two `<audio>` elements on one clock through Web Audio (A/B gains, mono and phone modes, meter, loops). |
| `app/web/js/command.js` | Command menu, shortcut sheet, row menu and every keyboard shortcut (`SHORTCUTS` drives the sheet). |
| `app/web/js/draw.js` | Canvas drawing: waveforms and the energy arc. |
| `app/web/js/analysis.js` | Transition chips (tempo, Camelot key, energy at the seam) and the clean-up summary. |
| `app/web/js/util.js` | DOM helpers, formatting, toasts, tooltips and the icon set. |
| `app/web/assets/` | Icons, the link preview and screenshots, copied from `design/`. |
| `app/data/`, `app/cache/`, `app/state/` | Generated or personal; ignored by git. |

## How playback works

- **No version picked:** A is the original mix and B the album master, on the same clock. (A released album has no separate original, so A/B is hidden until a version is picked.)
- **A version picked:** A is the album master and B the version. B runs at the version's speed, so the two are on different clocks and only the side you hear plays. Switching sides puts the other file at the same moment in the song (`songTime = bTime × speed`), starts it, and parks the silent one. (Keeping both running and re-seeking the hidden one stuttered.)
- Switching A/B is a 12 ms gain crossfade. **Match** turns B down by the loudness difference (integrated LUFS from the data).
- **Loops and marks are stored in song time**, so they stay on the same moment when you switch versions.
- **Listening modes:** stereo, mono (a fold-down), and phone (mono, 350 Hz high-pass, 5 kHz low-pass).
- **Play through** waits the gap, then plays the next song. **Hear transition** plays the last N seconds of one song, the gap, then N seconds of the next.
- **Instant starts:**
  - The engine has two pairs of `<audio>` elements. The standby pair preloads the next song in the running order (or the next song of a transition preview), so starting it is just a swap.
  - With a 0 s gap, the next song starts about 30 ms before the current one ends, instead of waiting for the browser's `ended` event. That is as close to gapless as `<audio>` gets.
- **Clicking a song** plays it. Clicking the song that's playing pauses or resumes it.

## HTTP API

| Method and path | Does |
|---|---|
| `GET /`, `GET /app`, `GET /soon` | Homepage, app, and "coming soon" (where the online demo's install links go). |
| `GET /css/*`, `/js/*`, `/assets/*` | Static files from `app/web/`. Paths can't leave that folder. |
| `GET /api/health` | `{ok, name, version, mode: "local" \| "demo", albums}`. |
| `GET /api/albums` | `app/data/albums.json`. In demo mode only the demo, unless `?cards=1` (the homepage's album cards). |
| `GET /data/<id>.json` | One album's data. |
| `GET /audio/<id>/<orig\|master>/<track>` | A track's audio. Range requests work, for seeking. |
| `GET /audio/<id>/version/<track>?v=<label>` | One of its versions. |
| `GET /api/state?album=<id>` | Saved state. |
| `POST /api/state?album=<id>` | Save state. Needs the header `X-God-Mix: 1`. |
| `POST /api/open` | `{album, folder: orig\|master\|versions, sub?}` opens a folder; `{album, track, where, version?}` reveals a file; `{job}` opens a finished export's folder. Needs `X-God-Mix: 1`. |
| `GET /api/jobs` | Recent jobs, newest last: `{id, kind, album, label, status: queued\|running\|done\|error, p, msg, result, error}`. |
| `POST /api/jobs` | Queue `{kind: "make", album, tracks?, versions?}` (empty means all), `{kind: "export", album, what, version, items, gap, formats, meta, isrc, cover}`, `{kind: "album", action: "add" | "edit", id?, title, subtitle, artist, folder?}`, or `{kind: "trace", album, items, version, recipients, phrase, voice, say_name, clips, density, formats}`. The server checks every track id, version and format against the album data. Needs `X-God-Mix: 1`. |
| `POST /api/folder` | `{path}`: the audio files in a folder, to preview a new album. Needs `X-God-Mix: 1`. |
| `GET /api/demo-export?fmt=wav\|flac\|mp3` | The homepage's download: `{ready, url, name, size}` once the file exists, else `{ready: false, job}` after queueing the export. `GET /api/demo-export/file?fmt=` serves it as a download. |
| `GET /api/trace` | Trace Tags: `{clips, total, recent}`, the saved tag recordings and the latest copies (no paths). `GET /api/trace/clip?name=` plays a recording; `POST` (raw audio, up to 30 MB) saves one, `POST ?clear=1` removes it. Plain file names only. |
| `POST /api/trace/preview` | `{text, voice}`: the words spoken by the computer's voice, as a WAV. |
| `POST /api/trace/check?ext=mp3` | A leaked file (raw audio, up to 300 MB): queues a `trace-check` job whose `result.match` says whose copy it is. |
| `GET /api/cover?album=<id>` | The album's export cover. `POST` with PNG or JPEG bytes sets it (up to 20 MB); `POST ?clear=1` removes it. Kept in `app/state/covers/`. |

**Jobs** run `app/jobs.py` with the repo's `.venv` Python (or `GODMIX_PYTHON`). Its progress lines (`@@ {"p", "msg"}`) drive the bars in the sidebar and the "make it" rows. When a make job finishes, the app re-reads the album data in place.

**Exports:**
- **Where they go:** `<album folder>/Exports/<album> <date time>/`. Released albums' files are never touched.
- **Formats:**
  - **As made** (WAV, AIFF, FLAC, ALAC) keeps the file's samples bit for bit.
  - **WAV 24-bit 48 kHz, 24-bit 44.1 kHz and 16-bit 44.1 kHz:** a rate change is resampled and limited under the true-peak ceiling, and fewer bits are dithered. 16 → 24-bit at the same rate is exact. The 16-bit render `versions.py` already made is used where there is one.
  - **MP3 320 and AAC 256**, with ALAC, need ffmpeg (`GODMIX_FFMPEG`, PATH, or WinGet's copy).
  - **Tags:** ID3v2.4 in WAV, AIFF and MP3, Vorbis comments in FLAC, MP4 atoms in ALAC and AAC.
- **Every format gets the cover.**
- **The full album** joins the songs sample-accurately with silent gaps. If the songs' formats differ, it uses 24-bit 48 kHz. It comes with a `.cue` sheet (with ISRCs) and `Tracklist.txt` with start times.
- **Songs without the chosen version** use the album version, and the dialog says which.

**Trace Tags** (`trace_tags.py`, run by the `trace` job):
- **What a copy is:** the song (or a version) with a spoken tag dropped in about every 8 to 15 s (light: 16 to 24 s, heavy: 5 to 9 s). Each tag moves up to 0.6 s onto the loudest nearby moment, gets its own pitch (±1 semitone), pan and level (±1.5 dB), and the music dips 3 dB under it. The music keeps its level; only the tag's peaks are caught, at -1 dBTP.
- **The tag:** typed words spoken by the computer's own voice (Windows speech, macOS `say`, or espeak on Linux), the recordings in `app/state/trace-clips/`, or both, rotated. "Say each person's name" adds "For <name>" to about a third of the tags.
- **Why each copy is different:** the tag times come from the person's name, the song, the time it was made and this install's secret key (`app/state/trace-key.txt`), so two copies differ from the first tag on, and nobody without the key can predict them.
- **Where they go:** `<album folder>/Exports/Trace Tags <date time>/<person>/`, MP3 320 and/or WAV, tagged with "Trace Tag copy for <person>".
- **The ledger:** every copy, with its source file and tag plan, is added to `app/state/trace-tags.json`. Keep it: it's what Check a leak reads.
- **Check a leak:** the file is lined up with each source song, the sound it has beyond the song is measured frame by frame, and that is compared with every copy's tag plan. Tested: a whole copy, a 40 s clip re-encoded at 128 kbps and a 20 s mono MP3 all named the right person (scores about 0.5 to 0.6 against about 0 for the others); the untagged song matched no one.
- **What it can't do:** it makes a leak traceable, not impossible. People who compare two copies can find the tags and cut them out, and a leak that has been sped up or slowed down won't line up with the copies, so Check a leak can't name it. Each copy also says "Trace Tag copy for <name>" in its comment tag; anyone can clear that, and it doesn't matter to Check a leak, which listens to the audio.

**Security:** audio is served only from paths listed in the data files. POSTs need a custom header, which forces a CORS preflight the server never approves, so other websites can't write here. The server listens on `127.0.0.1` only. In demo mode it refuses every POST and never shows a path (see below).

## The online demo

`node app/server.js --demo` (or `GODMIX_DEMO=1`) is the copy that runs on a website as **Try GODMIX**. It is the same code and pages, with these differences:

| | Installed | Online demo |
|---|---|---|
| Albums | Every album in `albums.json` and `local/albums.json` | The demo (000) only. Other albums' data and audio answer 404. The homepage's album cards come from `?cards=1`, which sends released albums only (titles and loudness art); only 000's opens. |
| Audio | The files themselves | MP3 320 copies from `app/cache/public/audio/<song>/<master \| orig \| version label>.mp3`, cached a day. With no copy, it falls back to the file in the data. |
| Album data | As built | The same, with every folder and file path removed. |
| Notes, marks, order, notepad | `app/state/<album>.json` | The visitor's browser (`localStorage`, `godmix.demo.<album>`). `GET /api/state` answers `{}`. |
| Make versions, export, add or edit albums | Run as jobs | Each says it comes with the app, coming soon, with a link to `/soon`. The "make it" rows read "in the app". |
| Folders, "show the file" | Open the file manager | Hidden. |
| Every `POST` | Allowed with the header | `403`, so the server never writes anything. |
| The homepage's download | Exported on first request | The files `build_public.py` made in `app/cache/public/download/`. Nothing runs. |
| Pages | As written | Served with `<html class="demo">`: the buttons say **Try GODMIX**, and the app shows a thin bar ("You're trying GODMIX with 000 by Kyler Simzer…"). `.if-demo` and `.if-local` show text for one or the other. |
| Setup, GitHub links | Shown | Hidden. Setup, "Set it up" and the bar's button point to **`/soon`**: Try GODMIX, and kyler@stems.fm. |

**To try it locally:** `python app/build_public.py`, then `npm run demo` (http://localhost:8334).

**What a server needs:** Node 20+, the repo's `app/` and `package.json`, `app/data/albums.json` and `app/data/demo.json`, and `app/cache/public/`. It needs no Python, ffmpeg or FLACs. Run it behind a proxy such as nginx: it listens on `127.0.0.1` (`GODMIX_HOST` to change it), and the proxy adds HTTPS. Re-run `build_public.py` and copy the folder again whenever the demo's versions change.

## Saved state (`app/state/<album>.json`)

Plain JSON, so scripts (or an AI agent) can read it to act on notes.

```jsonc
{
  "order": ["3. song.wav", "1. other.wav"],          // running order, by track id (source filename)
  "notes": { "3. song.wav": "free text" },
  "marks": { "3. song.wav": [{ "t": 42.5, "text": "hats harsh" }] },   // t = seconds of song time (the master's clock)
  "status": { "3. song.wav": "work" },               // "work" (needs work) or "done" (approved)
  "titles": { "3. song.wav": "New Title" },          // renamed titles: shown everywhere, used in exports
  "meta": { "artist": "Kyler Simzer", "album": "000", "year": "2025", "copyright": "© 2025 …" },   // export tags
  "isrc": { "3. song.wav": "QZS652557969" },         // ISRCs typed in the export dialog (the data's own are the default)
  "exportPrefs": { "what": "songs", "version": "", "formats": ["wav", "mp3"] },
  "fixes": { "3. song.wav": { "bpm": 60, "key": "A major" } },   // corrected analysis (bpm, key, I, loud, LRA, TP, bright_hz, start_lufs, end_lufs)
  "pad": { "tabs": [{ "id": "t1", "title": "To do", "text": "…" }], "active": "t1" },   // the Notes notepad
  "albumNotes": "free text",                      // the Mix notes box
  "settings": { "cont": false, "gap": 2, "tlen": 10, "match": false, "mode": "stereo" },
  "last": { "track": "3. song.wav", "t": 61.2 }      // where playback was, to pick up again
}
```

Preferences that belong to one browser (theme, volume, panel, transitions, last album) are in `localStorage` under `godmix.*`.

## Album data (`app/data/<id>.json`)

`{id, title, subtitle, artist, released, demo, year, version_kinds, env_fps, folder, masters_folder, versions_folder, tracks: [...]}`. Each track has:

- **Identity:** `name` (id = source filename), `n`, `title`, `stem`, and `isrc` (from the album registry, or a stems.fm config where one is set).
- **Measurements:** `dur`, `before`/`after` `{I, loud, LRA, TP}` (original and master), `bpm`, `key`, `camelot`, `key_sure`, `start_lufs`, `end_lufs`, `build_s`, `fade_db`, `bright_hz`.
- **Drawings:**
  - `curve`: short-term LUFS every second, for the energy arc. The album list (`albums.json`) also carries each album's `art` (`curve` downsampled to 240 points, and each track's start as a fraction), for the homepage's cards.
  - `wave`: peak every 0.1 s, for the homepage illustrations.
  - `env`: base64 bytes, `env_fps` (40) frames a second, interleaved [peak, RMS] on a −60…0 dBFS scale. The player and details waveforms are drawn from this, like stems.fm's tracks. Versions have an `env` too.
- **Clean-up:** `edge` (albums being mastered only).
- **Versions:** `versions: [{label, speed, dur, I, wave}]`.
- **Files the server may play:** `paths {orig, master, versions{label: path}}`.

## Deep links

`/app#/<album>/<track number>`, for example `/app#/demo/4`. The hash follows the selected track.

## Keyboard

Press `?` in the app for the full sheet, which is drawn from `SHORTCUTS` in `command.js`. The main shortcuts:

- `Space` play or pause; `←` `→` move 5 s; `Shift ←` `Shift →` previous or next track.
- `A` `B` `Tab` switch A/B; `0`–`9` pick a version; `M` cycle mono and phone; `G` match loudness.
- Drag on the waveform to loop; `[` `]` set the loop ends; `L` turn the loop on or off.
- `N` mark this moment; `S` change status; `Alt ↑` `Alt ↓` move a track; `Ctrl Z` undo; `F2` rename; `E` export; `R` Trace Tags; `P` notepad.
- `Ctrl K` (`⌘ K` on a Mac) opens the command menu.
