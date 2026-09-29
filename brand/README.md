# Ficus brand assets

Source SVGs for the Ficus mark, and a generator that renders every icon Core
web, Platform web, Core docs, Desktop and Mobile need.

**Nothing here is wired into any app yet.** These are sources and generated
outputs only; swapping an app over to them is a separate, later change.

## Sources

- `ficus-mark.svg` — the full mark (leaf + pot), light palette. 64×64 viewBox, transparent background.
- `ficus-mark-dark.svg` — the same mark, dark-mode palette.
- `ficus-favicon-16.svg` — a simplified single-leaf mark for use at ≤16px, where the full mark's detail doesn't survive.

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
regression test that re-renders to a temp directory and diffs against the
committed output.

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
  rounded-square tile (824×824, corner radius 185, centered in a
  transparent 1024 canvas), following Apple's icon grid.
- `mobile/` — `icon.png` (1024, opaque, iOS), `adaptive-icon.png` (1024,
  transparent, Android foreground), `adaptive-background.png` (1024, solid
  linen), `splash-icon.png` (1024, transparent), `notification-icon.png`
  (96, pure white silhouette on transparent, Android monochrome).
- `docs/favicon.svg` — same as `web/favicon.svg`.
