# GODMIX design

Open [`index.html`](index.html) in a browser to see every asset on one page.

The mark is stems.fm mark **136, "Three dials"** (a variation on 106, "Dial"): three knobs at three settings. It comes from the stems.fm brand marks and is copied into [`brand.mjs`](brand.mjs) so this repo stands on its own. The app uses the **all-white** mark. The **toned** mark (one ink at 100, 70 and 45%) is the stems.fm look, for use beside stems.fm.

## Files

| Folder | What | Use |
|---|---|---|
| `logo/` | `godmix-mark-{white,toned,black,current}.svg` | The mark on its 24 × 24 grid (as stems.fm draws it). `current` follows CSS `currentColor`. |
| | `…-cropped.svg` | The same, cropped to the dials (3:1), for inline use. |
| | `godmix-mark-{white,toned,black}-1024.png` | Transparent PNGs for avatars, press and anywhere SVG isn't accepted. |
| | `godmix-mark-{white,toned}-on-black-1024.png` | Square, on black: profile pictures. |
| | `godmix-lockup-{white,toned,black}.svg` / `-2x.png` | Mark + GODMIX wordmark (Geist SemiBold). Prefer the PNGs: the SVG text needs Geist installed. |
| `icons/` | `favicon.svg`, `favicon-16/32.png`, `apple-touch-icon.png`, `icon-192/512.png`, `icon-512-maskable.png` | Browser tab, home screen and install icons. Copied into `app/web/assets`. |
| `banners/` | `godmix-banner-readme-1600x480`, `-x-1500x500`, `-github-1280x640`, `godmix-link-preview-1200x630` (PNG + SVG) | README header, X header, the GitHub repo's social preview, and the link preview the homepage uses. The bars along the bottom are an album's real loudness curve. |
| `screens/` | `app-dark.png` (2×), `app-dark-1x.png` | Screenshots of the app for the homepage and README. |

## Rebuilding

```bash
node design/build.mjs          # every logo, icon and banner, then copies the app's icons into app/web/assets
node design/screenshot.mjs     # app screenshots (start the server first: npm run serve)
```

Both use headless Chrome, or Edge if Chrome isn't installed (`GODMIX_BROWSER` picks another). The text in the PNGs loads Geist from Google Fonts, so building needs an internet connection. The banners take their loudness bars from the demo album (`app/data/demo.json`, built by `python app/build_data.py demo`).

## Rules

- **Colour comes from the music.** The interface is one off-white ink (`#ECEBE6`) on black, like stems.fm. Green, amber and red are only for status. Tokens are in [`app/web/css/tokens.css`](../app/web/css/tokens.css).
- **Type:** Geist for words, Geist Mono for numbers, times and labels. Interface text is 13 px; headings have tight tracking.
- **The dials stay in order:** off, a little, most of the way, left to right. Don't rotate or mirror the mark, or recolour single dials.
- **Clear space:** at least one dial's height on every side. **Smallest size:** 16 px wide; below that, use the tile icon.
