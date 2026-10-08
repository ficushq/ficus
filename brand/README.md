# Ficus brand assets

Source SVGs for the Ficus mark, and a generator that renders every icon Core
web, Platform web, Core docs, Desktop and Mobile need.

The apps use the generated icons below. The social preview card and the App
Store art are generated too, from templates, with their fonts embedded.

## Sources

- `ficus-mark.svg` — the full mark (leaf + pot), light palette. 64×64 viewBox, transparent background.
- `ficus-mark-dark.svg` — the same mark, dark-mode palette.
- `ficus-favicon-16.svg` — a simplified single-leaf mark for use at ≤16px, where the full mark's detail doesn't survive.

In each, the pot body starts 0.75 units up under the rim so the two shapes
overlap; where they only touched, antialiasing left a hairline across the pot
at large sizes.

## Social preview

The 1280×640 link-preview card adapts the ficus.sh hero illustration: the
"Keep work moving / while you’re away." headline in Fraunces, with the
supporting line under it in Instrument Sans, beside the hero plant, which stands in its pot on the card's ground rule in front of a sage sun,
with two status chips ("Checks passed", "Ready for your review") on leader
lines. The headline and supporting line are `HEADLINE` and `SUPPORTING_LINE`
in `scripts/brand/social-preview.ts`, shared with the App Store search art:
change the copy there and regenerate, and both follow (the supporting line
wraps itself into two balanced lines). It's sized for how cards are seen, 400–600px wide in X, Slack,
iMessage and GitHub: nothing that matters is set below 24px at full size.

- [`social-preview.svg`](social-preview.svg) / [`social-preview.png`](social-preview.png) — the light card, the one that's published.
- [`social-preview-dark.svg`](social-preview-dark.svg) / [`social-preview-dark.png`](social-preview-dark.png) — the same card on soil, with the dark mark palette and sage accents.

The SVGs are generated; don't edit them by hand. Change the template in
`scripts/brand/social-preview.ts`, then run:

```
bun run brand:social      # just the cards
bun run brand:generate    # icons, the cards, then the App Store art
```

It writes both SVGs (embedding the mark from the source SVGs above and the
fonts below), renders each at 1280×640, device scale 1, in headless Chrome via
`playwright-core` once `document.fonts.ready` resolves, and copies the light PNG
to every place that publishes it: `.github/social-preview.png` and
`apps/web/public/social-preview.png` (served at `/social-preview.png`). It needs
Google Chrome installed. `scripts/brand/social-preview.test.ts` fails if a copy
drifts from `brand/social-preview.png`, if a committed SVG differs from its
template, or if an SVG stops embedding both font families; it compares
committed files and never launches Chrome.

Two copies live outside this generator's reach:

- **GitHub:** committing the PNG does not change the repository's preview.
  Upload `brand/social-preview.png` by hand in the repo's
  **Settings → General → Social preview**.
- **Platform:** the private ficus-platform repo serves its own copy. Copy
  `brand/social-preview.png` and `brand/social-preview.svg` to
  `apps/platform/web/public/social-preview.{png,svg}` there, and update its
  `og:image:alt` to the card's copy.

## App Store art

Promotional art for the iOS App Store product page, in
[`app-store/`](app-store/) (SVG sources) and `generated/app-store/` (the PNGs
to upload in App Store Connect). Every PNG is opaque sRGB, 8-bit RGB with no
alpha channel, at Apple's exact sizes.

| Asset                | Sizes                | Source                           |
| -------------------- | -------------------- | -------------------------------- |
| Product page header  | 5244×2950, 3840×1646 | `app-store/header-<size>.svg`    |
| Search results image | 3840×2560, 1920×1280 | `app-store/search-3840x2560.svg` |

- **Header:** art plus the wordmark only. The hero plant, in its pot in front of
  the sage sun, stands on a horizon beside a lowercase Fraunces "ficus"; both
  rest on the same ground line. The rest of the canvas is the linen scene (sky
  glows, distant hills, a few sprouts) running to the edges. The app's name and
  subtitle appear below the art on iPhone, and the status bar, Dynamic Island
  and round back/share buttons cover its top, so the lockup is centered
  horizontally and sits low: its top leaf starts 37% of the way down (the
  overlays cover the top ~18%), and it spans the central 48% of the 5244 width,
  so the narrower slice iPhone shows keeps it whole. Each size is laid
  out at the 2950px reference height and scaled to its own height, so the
  lockup stays centered at the same size relative to the canvas, and wider
  canvases only reveal more scene.
- **Search results:** the card's headline in Fraunces (236px at 3840, line 2 in
  leaf green) and supporting line in Instrument Sans (100px), on the left;
  an iPhone on the right showing the Ficus mobile Feed, with the hero plant on
  the ground rule beside it and the sage sun behind it. The text is sized to read
  where the art is shown, about 350pt wide under the app's name in search
  results. The phone outline (body, side buttons, Dynamic Island, home
  indicator) is drawn by the template; it isn't one of Apple's device frames.
- **Phone screen:** [`app-store/feed-screen.png`](app-store/feed-screen.png),
  1179×2556, is a capture of the interactive demo at ficus.sh/mobile/ (sample
  data) on its Feed: "Needs attention" with a question and a "Review needed"
  card. It's committed so rendering works offline. The capture strips the demo's
  own bezel and sizes it to 393×852 CSS px at 3x. The demo sets its UI in the
  system font, so capture on macOS for San Francisco. To recapture after the
  demo changes:

  ```
  bun run brand:app-store --capture
  ```

```
bun run brand:app-store   # just the App Store art
```

It builds the SVGs (embedding the font subsets each one uses and, for the
search art, the screen PNG), renders each in headless Chrome once its fonts load
(the 1920×1280 search art is the same SVG rendered at half size), and writes the
PNGs. `scripts/brand/app-store.test.ts` checks committed files only: each PNG's
exact size, RGB color type with no alpha, palette or `tRNS`; each SVG against
its template, its embedded fonts and screen, and no network references; and
Apple's text rules (the header's only text is the wordmark; no URLs or prices
anywhere).

Apple's rules for this art: no URLs, prices, awards, other platforms' logos or
unverified claims; focal elements centered and within the safe area; short
text. The search art is English only. **If the app adds languages, the search
art needs a localized variant per language** (the header carries only the
wordmark and doesn't).

## Fonts

The cards embed subset WOFF2 fonts as base64 `@font-face` rules, so they render
the same wherever the SVG is opened, with no network fetch.

| Font            | Source                                                                                   | License                                      |
| --------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------- |
| Fraunces        | `fonts/fraunces/Fraunces[SOFT,WONK,opsz,wght].ttf`, google/fonts `ofl/fraunces`          | SIL OFL 1.1, `fonts/fraunces/OFL.txt`        |
| Instrument Sans | `fonts/instrument-sans/InstrumentSans[wdth,wght].ttf`, google/fonts `ofl/instrumentsans` | SIL OFL 1.1, `fonts/instrument-sans/OFL.txt` |

Both sources are the upright variable fonts from
[google/fonts](https://github.com/google/fonts) at commit `5e8a3ba8`, the same
families ficus.sh loads from Google Fonts. Neither license reserves a font
name. `scripts/brand/subset-fonts.sh` builds `fonts/subset/fraunces.woff2`
(semibold, optical size kept variable) and `fonts/subset/instrument-sans.woff2`
(weights 400–700) from them, limited to Basic Latin plus a little typographic
punctuation. It needs `fonttools` and `brotli` (dev-only, not a repo
dependency); rerun it only when the sources or its character set change.

## Palette

| Token          | Hex       | Use                          |
| -------------- | --------- | ---------------------------- |
| Linen          | `#f1e9db` | Light-mode tile / background |
| Soil           | `#1c1a17` | Dark-mode tile / background  |
| Leaf           | `#3f6b4f` | Light-mode leaf              |
| Moss           | `#8a9a5b` | Light-mode side leaves       |
| Terracotta     | `#b0582f` | Light-mode pot               |
| Dark-mode sage | `#9fb57f` | Dark-mode accent             |

`ficus-mark-dark.svg` uses `#5e7f4e` (leaf), `#87945a` (side leaves) and
`#c46a3c` (pot) — a recolor of the light palette, not the dark-mode sage
accent above.

## Type

- **Fraunces** — display face; the lowercase "ficus" wordmark.
- **Instrument Sans** — body text.
- **JetBrains Mono** — code.

## Generating icons

```
bun run brand:generate
```

Renders `brand/generated/` from the three source SVGs above using `sharp`.
The generator builds one composite SVG per output (a background shape plus
the mark's own path data, scaled and centered by a transform computed from
the mark's measured content bounding box) and rasterizes each in a single
pass, so output is deterministic byte-for-byte across runs. See
`scripts/brand/generate.ts` for the exact sizes, fill ratios and per-target
background/transparency rules, and `scripts/brand/generate.test.ts` for the
regression tests (`cd scripts/brand && bun test ./generate.test.ts`). These
use trusted repository SVGs, compare two fresh renders byte-for-byte, and
compare every decoded PNG pixel and its color/alpha/palette metadata against
the committed output. SVGs are compared byte-for-byte. PNG compression can
change across native-library versions without changing any pixels; do not
rewrite the committed imagery just to accept a dependency upgrade.

The direct `sharp` dependencies require Node >=20.9 (CI uses Node 24) or the
repository's pinned Bun runtime. Use the optional prebuilt platform packages;
source builds are opt-in in sharp 0.35. The Linux x64 glibc artifact requires
glibc >=2.28; its musl counterpart requires musl >=1.2.5 (check the selected
artifact's prerequisites on other architectures). If building against global libvips,
it must satisfy sharp's patched minimum (8.18.6 for sharp 0.35.4). Check
`sharp.versions` to verify the actually loaded library, not just the manifest.

### Generated layout

- `web/` — Core web + Platform web share this set: `favicon.svg`,
  `favicon-16x16.png`, `favicon-32x32.png`, `apple-touch-icon.png` (180),
  `icon-{72,96,128,144,152,192,384,512}.png`,
  `icon-maskable-{192,512}.png`, plus mark-only `shortcut-chat.png` /
  `shortcut-tasks.png` (96) standing in for the two manifest shortcut icons
  the source brief didn't cover — replace with distinct glyphs later if
  wanted. `web/dark/` mirrors the same raster sizes on soil, for future use.
- `farm/` — the farm app (`apps/farm`, its Vite public dir): the light mark
  standing in the farm's meadow (`#a3bb5d`) under its sky (`#8fd3f2`), the
  horizon running through the pot: `favicon-{16x16,32x32}.png`,
  `apple-touch-icon.png` (180), `icon-{192,512}.png` and
  `icon-maskable-{192,512}.png`, for its manifest and home-screen icon.
- `desktop/` — `icon-1024.png` / `icon-1024-dark.png`: mark on a linen/soil
  tile following Apple's macOS app icon template: an 824×824
  continuous-corner ("squircle") tile, radius 185 with 60% corner smoothing,
  centered in a transparent 1024 canvas over a soft drop shadow (28px blur,
  12px down, 30% black).
- `mobile/` — `icon.png` (1024, opaque, iOS), `adaptive-icon.png` (1024,
  transparent, Android foreground), `adaptive-background.png` (1024, solid
  linen), `splash-icon.png` (1024, transparent), `notification-icon.png`
  (96, pure white silhouette on transparent, Android monochrome).
- `docs/favicon.svg` — same as `web/favicon.svg`.
- `app-store/` — the App Store art, rendered in Chrome by
  `scripts/brand/app-store.ts` rather than by this generator; see
  [App Store art](#app-store-art).

### Published copies

Core web and Core docs each need these files in their own public dirs
instead of reading `brand/` directly, so `bun run brand:generate` also
copies them there, byte-for-byte, after rendering (`PUBLISHED_ICON_COPIES` in
`scripts/brand/generate.ts`; `scripts/brand/published-icons.test.ts` fails if
any copy drifts from its source). The farm app (`apps/farm`) needs no copy:
its Vite `publicDir` points straight at `brand/generated/farm`.

| Copy                                       | Source                                                           |
| ------------------------------------------ | ---------------------------------------------------------------- |
| `apps/web/public/icons/**`                 | `brand/generated/web/**` (same relative path, including `dark/`) |
| `apps/web/public/icons/icon-source.svg`    | `brand/ficus-mark.svg`                                           |
| `apps/docs/public/favicon.svg`             | `brand/generated/web/favicon.svg`                                |
| `apps/docs/src/assets/ficus-mark.svg`      | `brand/ficus-mark.svg`                                           |
| `apps/docs/src/assets/ficus-mark-dark.svg` | `brand/ficus-mark-dark.svg`                                      |

Platform web (`apps/platform/web/public/icons/`, the private ficus-platform
repo) still needs its copy refreshed by hand, the same way as its social
preview copy above.
