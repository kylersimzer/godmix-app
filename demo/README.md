# Demo album: 000 by Kyler Simzer

`demo/000/` holds the complete album **000** by **Kyler Simzer**: 11 songs as FLAC (16-bit, 48 kHz). They are lossless copies of the released masters, with the same samples, bit for bit, tagged with each song's title, track number, ISRC, the © line and where to listen. They are here so that anyone who clones GODMIX has a real album to open, A/B, make versions from, sequence and export.

**Listen to 000 and the rest of Kyler's music:** [kylersimzer.com](https://kylersimzer.com) · [Spotify](https://open.spotify.com/artist/7aVm8fnxM8eVrusQveFs98) · [Apple Music](https://music.apple.com/us/artist/kyler-simzer/1826036316) · [SoundCloud](https://soundcloud.com/kylersimzer) · [YouTube](https://www.youtube.com/@kyler_)

**© 2025 Kyler Simzer. All rights reserved.** See [Rights](#rights) below.

## Using it

```bash
python app/build_data.py demo     # measure the demo album (a fresh clone builds only the demo)
npm start                         # it appears in the app under "Demo"
```

- **The album has no versions to start with.** In the details panel, click **make it** next to Slowed + Reverb, Sped Up, Other Room, Bass Boosted or Max Bass Boost. GODMIX designs the version from the song's measurements and renders it. Or use **Make every missing version** from the command menu (Ctrl K).
- **Where things are written:** versions go to `demo/000/Versions/` and exports to `demo/000/Exports/`. Both are kept out of git.
- **What's in `albums.json`:** the album is listed as id `demo`, the only album there (your own go in `local/albums.json`). Its year (2025) and each song's ISRC are in that entry too, so exports are tagged right.

| # | Title | ISRC |
|---|---|---|
| 1 | Blue | QZS652557969 |
| 2 | It | SE6XW2584380 |
| 3 | God Save Me When I Need You | QZS672598018 |
| 4 | Summer Rays | QZS662536797 |
| 5 | Suicide Song | QZJRB2565065 |
| 6 | Champion | QZKDK2564542 |
| 7 | Find You | SE6XW2584381 |
| 8 | Mantra | SE6XW2584382 |
| 9 | Since Birth | SE6XW2584383 |
| 10 | Nemo | SE6XW2584384 |
| 11 | Masterpiece | SE6XW2584385 |

## Rights

The recordings, compositions and lyrics in `demo/000/` are **© 2025 Kyler Simzer. All rights reserved.** They are included only so that GODMIX can be tried out. **No licence is granted** to:

- copy, share or upload them, including to streaming services and social media;
- sample, remix or re-release them;
- use them in film, TV, games or adverts (sync);
- use them to train or test AI or machine-learning models, or include them in datasets.

Any of these needs Kyler Simzer's written permission. Listening to them inside GODMIX, on your own machine, to evaluate the software is fine.

The MIT License for GODMIX's code does **not** cover these files. See [NOTICE.md](../NOTICE.md).
