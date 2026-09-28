# Graph and canvas colors

## Source of truth and adapters

`index.css` owns the active graph family in both Iris variants; Ficus and the other
recolors copy it. The default graph
scenes deliberately stay dark in **both** appearances. `tokenReader.ts` memoizes a
computed-style snapshot per root attribute revision; `useThemeColors` subscribes
to the applied theme/appearance/class/style surface. A change updates existing
2D callbacks, 3D materials/sprite labels and chart defaults, not a new scene key.
Graph data no longer stores palette snapshots, so hover swatches do not retain
old colors and a color-only change does not rebuild Agent/Org simulation data.

The bridge accepts fractional channels, slash alpha, and intrinsic-opacity
metadata (multiplicatively). `none`/`auto` remain absent colors. It does not try to
parse arbitrary CSS or monitor dynamically replaced stylesheets: registered
scopes and custom overrides change the root attributes, as the application does.
Imperative reads see root changes synchronously; React observes those changes
without relying on parent/child effect ordering. The last subscriber disconnects
its observer.

- Squad active/paused/archived aliases retain green/amber/gray through the
  success/attention/neutral **status tokens**. Agent colors use the authoritative
  role-to-marker-token mapping. Status semantics and other families are unchanged.
- Links 1–3 are reports/collaborates/depends; 4 is AgentVisualization's hub edge,
  5 is Universe membership, 6 is an additional themeable categorical slot.
- Separate label-muted, node-border, 3D-selected, loading-background and legend
  slots preserve the formerly distinct colors/alpha (including the old yellow
  paused legend and gray idle legend). The 2D selected ring stays indigo; the 3D
  selected node stays white.
- An existing sprite-import race was repaired: imports can finish between mount
  and selecting 3D, so readiness must await the shared promise even if SpriteText
  is already defined. Both imports must finish before labels are enabled.

## Contrast and intentional deltas

WCAG sRGB ratios, compositing alpha over `--graph-bg` (`17 24 39`), are identical
for light and dark. `graph.test.ts` gates labels at 4.5:1 and links at 3:1.

| Pair                                       | Light |  Dark |
| ------------------------------------------ | ----: | ----: |
| Main label / scene                         | 17.74 | 17.74 |
| Secondary label (white at 0.5) / scene     |  5.25 |  5.25 |
| Reports link / scene                       |  3.67 |  3.67 |
| Collaborates link / scene                  |  4.82 |  4.82 |
| Depends link / scene                       |  6.99 |  6.99 |
| Hub/membership link (white at 0.4) / scene |  3.79 |  3.79 |

The old translucent edges failed: white at 0.2 is 1.88:1 in 2D; the 3D library
also multiplies input alpha by its default `linkOpacity=0.2` (so hub alpha was
0.04 and membership alpha 0.02). Relationship cylinders were also dimmed by this
multiplier. **Contrast-driven adjustments:** graph link 4 changes from alpha 0.2
to 0.4, link 5 from 0.1 to 0.4; all three 3D consumers explicitly set linkOpacity
to 1. Relationship RGB hues are unchanged. These are intentional visibility
changes, not a claim of zero pixel difference. Arrow opacity follows the same
library link opacity. No other default graph/chart palette values were changed.

These are token/material-input contrast gates, not a blanket accessibility
certification: perspective, small label size, anti-aliasing, lighting on cylinders,
zoom and occlusion still affect rendered pixels. Chromium/SwiftShader inspection
of real OrgGraph and AgentVisualization verified 3D labels and edges, light/dark
and live custom overrides (including background, label and status aliases).

A pre-existing Universe mount failure is inherited, not introduced here: its
force effect can reheat before the library initializes `state.layout`,
causing an undefined `tick` error, so a successful Universe WebGL browser run
is **not** claimed. Its palette, contrast and subscription wiring are still
covered by tests. Whether this initialization timing also occurs in the
complete application remains unverified.

## Charts are content, not chrome

`chartThemeConfig` provides low-priority Vega/Vega-Lite defaults. Dedicated
`--graph-chart-*` tokens preserve the libraries' existing white/black/blue/gray
and tableau10 defaults; sharing the dark-scene palette would change existing
presentations. Vega's transparent background remains transparent. Tests compile
and render actual charts to SVG, comparing normalized colors and full geometry
against the library without the adapter (eight mark types plus Vega).

The adapter never mutates the spec, data, encodings, explicit ranges or schemes.
A typed field encoding without a palette still receives categorical defaults.
Any authored color/palette directive (including a signal, conditional value,
null fill, background, nested config/style or range) opts the **whole spec** out
of defaults. This is intentionally conservative: mixing theme defaults into a
partial authored palette can break its internal contrast. Other library defaults
(e.g. quantitative/sequential schemes) remain library-controlled, not guessed
from a six-color graph palette. External URL blocking and the loader are unchanged.

## Verification

- `tokenReader.test.tsx`: concrete color conversion, intrinsic alpha, fractional
  channels, sentinels, snapshot reuse, synchronous read plus observer notification,
  appearance/unified-theme switch, override/reset, disposal and mounted consumers.
- `useGraphModulesReady.test.tsx`: modules resolving before/after the 3D toggle,
  waiting for both imports, repeated toggles and cleanup of disabled effects.
- `graph.test.ts`: both real CSS palettes, semantic aliases, composited contrast,
  raw-color-free renderers, explicit 3D opacity and live consumer wiring.
- `chart.test.ts`: real Vega/Vega-Lite parity, palette changes, spec immutability
  and authored-color opt-outs. `tokenCoverage` enforces the full activated family.
- AgentVisualization/OrgGraph are removed from every raw-color allowlist; Universe
  retains only its audited token-derived inline hover swatch exception.
