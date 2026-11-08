# Notices: copyright, licences and third-party software

**GODMIX · © 2026 Kyler Simzer · [kyler@stems.fm](mailto:kyler@stems.fm)**
The code, the design and the music in this repository are by Kyler Simzer. Questions about rights or use go to the address above.

**In short: the code is free, the music is not.** The code is MIT licensed (section 2). Kyler Simzer's music is © Kyler Simzer, all rights reserved: the demo album in `demo/`, anything made from it, and all of his other music, wherever it appears (sections 1 and 2). The GODMIX and stems.fm names and marks aren't licensed (section 3).

## 1. The demo audio: all rights reserved

The album **000** by Kyler Simzer in `demo/000/` is **© 2025 Kyler Simzer. All rights reserved.** Its recordings, compositions and lyrics are included only to demonstrate GODMIX. No licence is granted to:

- copy, redistribute, upload or stream them;
- sample, remix or re-release them;
- use them for sync;
- use them to train or test AI models, or include them in datasets.

Full terms, the track list and the ISRCs are in [demo/README.md](demo/README.md). Anything GODMIX makes from the demo is a derivative of the same recordings and carries the same reservation. That includes versions, exports and full-album renders.

## 2. GODMIX's code

**© 2026 Kyler Simzer** ([kyler@stems.fm](mailto:kyler@stems.fm)). The code is open source under the **[MIT License](LICENSE)**: anyone may use, copy, change and share it, as long as the copyright notice and the licence come with it.

The MIT License covers the code only. It never covers the audio in `demo/` (section 1) or the names and marks (section 3).

**Kyler Simzer's other music** (every other album and song, released or not) isn't in this repository, and the MIT License doesn't cover it either. Its recordings, compositions, lyrics, artwork and track lists are © Kyler Simzer, all rights reserved. Using GODMIX gives nobody any rights in his music. Music you run through GODMIX stays yours.

## 3. Names and marks

**GODMIX**, the **Three dials** mark and the **stems.fm** marks belong to Kyler Simzer. They are not licensed for use by others, even if the code is.

## 4. Third-party software

| Used for | Package | Licence |
|---|---|---|
| Type | Geist, Geist Mono (Vercel); loaded from Google Fonts, not bundled | SIL Open Font License 1.1 |
| Audio files | soundfile (bundles libsndfile) | BSD-3-Clause (libsndfile: LGPL-2.1) |
| Maths | numpy, scipy | BSD-3-Clause |
| Analysis | librosa | ISC |
| Analysis | numba | BSD-2-Clause |
| Effects | pedalboard (Spotify) | **GPL-3.0** |
| Loudness models | mosqito | Apache-2.0 |
| Tags in exports | mutagen | **GPL-2.0-or-later** |
| Encoding checks, MP3 export | ffmpeg; run as a separate program, not bundled | LGPL-2.1+ or GPL, depending on the build |
| Brand renders and screenshots | Chrome or Edge in headless mode; run as a separate program | Proprietary / BSD (Chromium) |

The Node.js server and the web app use no third-party packages.

pedalboard (GPL-3.0) and mutagen (GPL-2.0-or-later) are GPL. They aren't bundled: `requirements.txt` installs them separately, under their own licences, and the MIT License is compatible with the GPL. Anyone who distributes GODMIX together with them as one package must follow the GPL for that package.

`design/brand.mjs` and `design/build.mjs` are code, under the MIT License; the marks they draw (section 3) are not licensed.
