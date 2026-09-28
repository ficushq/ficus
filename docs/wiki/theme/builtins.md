# Built-in themes and picker

## Intent and compatibility

- **Iris** (`tau`, dual) remains the default theme and light remains the fresh-install appearance.
- **Harbor** (`harbor`, dual): cool slate surfaces, restrained teal actions, dark blue-gray code/graph islands.
- **Forest** (`forest`, dual): the owner's own palette preset — pine-green actions, a warm bark secondary and mossy tertiary swatch, and an olive-gray chrome tint. See [Forest palette](#forest-palette) below.
- **Ember** (`ember`, dual): warm paper/charcoal surfaces and terracotta actions, warm dark code/graph islands.
- **High contrast** (`high-contrast`, unified): constant light ink-on-paper chrome, strong black boundaries and black code/graph backgrounds. This is not an application-wide AAA certification.
- Six palettes ported from the BigBrain project's own design tokens (`web/ui/src/design/tokens.css`), each a constant-appearance built-in like High contrast: **nurebairo** (`nurebairo`, dark), **Phosphorus** (`phosphorus`, light), **yamabukiiro** (`yamabukiiro`, light), **moegiiro** (`moegiiro`, dark), **adzukiiro** (`adzukiiro`, dark), **asagiiro** (`asagiiro`, dark). See [BigBrain palettes](#bigbrain-palettes) below.

The two recolors preserve status meanings and all seven used decorative Badge palettes. Every new CSS scope explicitly defines the full active token set plus intrinsic-opacity metadata. Fractional syntax channels, graph/status aliases, xterm's `none` selected-ink sentinel and `auto` scrollbar sentinel are retained. No runtime color generation or new runtime dependency is involved. App-owned palette utilities, brand, voice materials and presentation framing are tokenized; see [complete coverage](complete-coverage.md) for the guard and bounded content/definition exceptions. Authored artifact colors remain content-owned. Arbitrary ANSI combinations, custom overrides and utility-tone pairings are not universally contrast-certified.

The Settings control has a native labeled theme selector and Light/Dark/System selector. Unified themes disable appearance and explain why; switching back restores the previously selected appearance. Selection, surface snapshot (including `constant`), document background and theme-color meta update together before paint. The existing legacy toggle remains the rollback UI while `THEME_PICKER_ENABLED` is false.

## Adding a built-in theme

A checklist, verified by actually following it end-to-end to add Forest (a **dual** palette-derived built-in). Every step below is a real edit this repo needed for Forest; nothing here is aspirational.

1. **Registry entry** — `apps/web/src/theme/registry.ts`: add `{ id, label, kind, variantClass }` to `BUILT_IN_THEMES`, in the exact list position you want it to appear in the Settings grid and quick picker (Forest sits between Harbor and Ember). `kind: 'dual'` needs `variantClass: { light: null, dark: 'dark' }` (the dark migration class, same bridge Ficus's own dark variant uses); `kind: 'unified'` needs `variantClass: { constant: null }` or `{ constant: 'dark' }` — see [BigBrain palettes](#bigbrain-palettes) below for when a unified theme keeps the `dark` class at its one constant appearance.
2. **`SYNC_THEME_DESCRIPTORS`** — `packages/shared/src/theme-preferences.ts`: add the SAME id/label/kind, in the SAME relative position. `sync.test.ts` asserts `SYNC_THEME_DESCRIPTORS` equals `BUILT_IN_THEMES` mapped to `{ id, label, kind }` — position drift between the two files fails that test immediately.
3. **Token values — generate, don't hand-type.** Pick the generator path that matches your source palette:
   - A **primary/secondary/tertiary/neutral seed palette** (the same shape a user's own custom theme uses, e.g. an owner preset): add an entry to `PALETTE_BUILTINS` in `apps/web/scripts/generate-palette-builtins.ts` and run `bun apps/web/scripts/generate-palette-builtins.ts`. See [Forest palette](#forest-palette) below for the full derivation.
   - A **bg/fg/activity triple with its own explicit color-mix formulas** (e.g. a ported design system like BigBrain's): add an entry to `BIGBRAIN_PALETTES` (or extend `generate-bigbrain-builtins.ts`'s own explicit-token layer for a new source) and run `bun apps/web/scripts/generate-bigbrain-builtins.ts`. See [BigBrain palettes](#bigbrain-palettes) below.
   - Both generators share `apps/web/scripts/theme-builtin-shared.ts` (`DERIVABLE_TOKENS`, `cssBlockDeclarations`, `repairContrastPairs`) — reuse it rather than re-deriving the restricted chrome/swatch/on-accent-fg token set or the contrast-repair bisection by hand.
   - Both write into `apps/web/src/theme/builtins.css` inside their own `GENERATED … BUILTINS` marker region, with a freshness test (`generate-palette-builtins.test.ts` / `generate-bigbrain-builtins.test.ts`) that fails when the committed CSS drifts from a fresh run. A **dual** theme writes TWO scopes, `:root[data-theme='<id>'][data-appearance='light']` / `'dark'` (plus the `[data-theme-scope]` form for previews) — mirror Harbor/Ember/Forest's own selectors exactly. A **unified** theme writes ONE scope with no `[data-appearance]` — mirror High contrast/the BigBrain ports.
4. **Swatch tokens** — `--swatch-secondary`/`--swatch-tertiary` should resolve to the palette's own secondary/tertiary (or their hue-rotated fallbacks) so the theme dot's conic gradient actually shows the new theme's identity; both generators set this for you as part of `DERIVABLE_TOKENS`.
5. **Pre-paint surface fallback** — add the theme to the `surfaces` map in `apps/web/src/theme/flash.ts` (the `--color-bg-surface` of each appearance, read straight out of the generated CSS you just wrote), in the same registry position, then regenerate the shipped pre-paint script: `bun apps/web/scripts/generate-theme-flash.ts` (writes `apps/web/index.html`; a test fails when it goes stale).
6. **Raw-colors allowlist count** — `apps/web/src/no-raw-colors.test.ts` caps `flash.ts`'s allowlisted `color-function` matches at an exact count (one `--color-bg-surface` fallback per built-in surface: two per dual theme, one per unified theme). Adding a dual theme raises the cap by 2; a unified theme by 1. Raise the number and its comment — this is the same established category as every other built-in, nothing else changes in that test.
7. **Tests that must pass, unchanged (never weaken a gate to make one pass):**
   - `apps/web/src/theme/tokenCoverage.test.ts` and `builtins.test.ts` — every new scope defines exactly the registry's active token set plus opacity metadata (token coverage), and clears the strict WCAG contrast gate (`contrastPairs`) against every one of ITS OWN chrome surfaces.
   - `apps/web/src/theme/utilityParity.test.ts` and `semanticParity.test.ts` — the legacy-utility-colors fixture freezes `--status-ROLE-{50..950}` byte-identical to Ficus across every built-in; if your palette's `status: 'harmonized'` would move those (it shares the `--status-ROLE-` prefix with the semantic slots), use `status: 'static'` instead — see [Forest palette](#forest-palette)'s own note on this.
   - `apps/web/src/theme/flashScript.test.ts` — the full built-in × appearance × OS pre-paint matrix picks up a new theme automatically from `BUILT_IN_THEMES`; only the `flash.ts` surface table (step 5) needs a manual edit.
   - `apps/web/src/theme/registry.test.ts` — update the theme count and the exact `KNOWN_THEME_IDS` order deliberately; this is an order-sensitive test, not incidental breakage.
   - `apps/web/src/theme/sync.test.ts` and the Core `apps/core/src/routes/user-preferences.test.ts` route test — cross-check `BUILT_IN_THEMES` against `SYNC_THEME_DESCRIPTORS` and the preference-validation route.
   - If a contrast pair fails, fix it via the generator's mapping (a different explicit formula, or let `repairContrastPairs` nudge that one token) — never by weakening or skipping the gate.
8. **Docs** — add the theme to this file's intent list and a short palette/generation/contrast-repair section (like [Forest palette](#forest-palette) or [BigBrain palettes](#bigbrain-palettes) below).
9. **Real-browser check** — a throwaway local instance (never committed), Settings theme grid showing the new theme in its registry position, and a couple of real app pages (nav/header glass, Feed, Squads with a primary button) under every appearance the theme supports. Look at the screenshots yourself for a coherent look — no mismatched header/sidebar glass, no pale/garish chrome — then tear the instance down.

## Forest palette

Source: the owner's own "Forest" preset — `primary: #3f6b4f` (pine), `secondary: #7a5c3e` (bark), `tertiary: #8a9a5b` (moss), `neutral: #4a4a3f` (olive-gray), `contrast: 'standard'`, `status: 'harmonized'` as requested.

Forest is a genuine **dual** (light+dark) built-in, generated by `apps/web/scripts/generate-palette-builtins.ts` and baked into `apps/web/src/theme/builtins.css` between `GENERATED PALETTE BUILTINS` markers, positioned between Harbor's and Ember's own (hand-authored) blocks — matching Forest's position in `registry.ts`'s `BUILT_IN_THEMES` and `theme-preferences.ts`'s `SYNC_THEME_DESCRIPTORS` (regenerate with `bun apps/web/scripts/generate-palette-builtins.ts`; a freshness test in `apps/web/scripts/generate-palette-builtins.test.ts` fails when the committed CSS drifts from a fresh run, mirroring the BigBrain generator's own freshness test).

### Generation

Unlike the BigBrain palettes (a bg/fg/activity triple with BigBrain's own explicit sRGB mix formulas layered on top), Forest's preset is a genuine `ThemePalette` — the same primary/secondary/tertiary/neutral shape a user's own custom theme uses — so no explicit-token layer is needed. `generate-palette-builtins.ts` shares its `DERIVABLE_TOKENS` set, `cssBlockDeclarations` parser and `repairContrastPairs` contrast-repair pass with `generate-bigbrain-builtins.ts` (both now import them from `apps/web/scripts/theme-builtin-shared.ts`, extracted verbatim from the BigBrain generator so its own output and freshness test stay unchanged):

1. Parse Ficus's own `:root` (light) and `.dark` (dark) blocks in `index.css` into a token→value map, once per appearance.
2. Run the shared palette derivation (`deriveThemeOverrides`, the same pure engine `theme-derivation.ts` uses for custom themes) against that appearance's own base tokens with the Forest palette above, restricted ONLY to `DERIVABLE_TOKENS` (the `chrome` token family plus `--swatch-secondary`/`-tertiary`/`--on-accent-fg` — verified against the actual CSS to be the only tokens that vary between built-ins). Every other family (status, agent-type, badge-decoration, voice-material, utility-decoration/-chrome, log-terminal, ansi, brand, most of syntax/terminal/graph) is copied verbatim from Ficus's matching-appearance block, exactly like Harbor, Ember and every BigBrain-ported built-in.
3. Run the same strict-gate `repairContrastPairs` pass `generate-bigbrain-builtins.ts` uses, separately for light and dark.

`--swatch-secondary`/`--swatch-tertiary` land on the palette's own secondary (bark, `122 92 62`) and tertiary (moss, `138 154 91`) — the same values in both appearances, since the `swatch` bucket serializes the seed directly — so the theme swatch shows green/brown/moss in the picker. `--color-primary` (and its hover/active/light siblings) resolve to the pine seed, `63 107 79`, likewise identical light and dark, matching how Ficus's own `--color-primary` is also appearance-invariant.

**Status: static, not harmonized.** The preset's own choice is `status: 'harmonized'`, but the generated built-in uses `status: 'static'` instead. `utilityParity.test.ts`'s `legacy-utility-colors.json` fixture freezes every built-in's `--status-ROLE-{50..950}` ramp steps byte-identical to Ficus's own frozen values, for every palette in `BUILT_IN_THEMES` — including Forest. Those ramp tokens share the `STATUS_TOKENS` family (and the literal `--status-ROLE-` prefix) with the semantic fg/surface/badge slots that `deriveThemeOverrides`'s harmonized mode rewrites, so harmonizing would move the ramp values too and break that gate. Every existing built-in (Harbor, Ember, and all six BigBrain ports) already makes the same `'static'` choice for the same reason — "two recolors [that] preserve status meanings" — so Forest keeps it rather than weakening a parity gate to honor the source preset's own request.

### Contrast

The strict built-in gate (`apps/web/src/theme/builtins.test.ts`'s `contrastPairs`) checks every foreground — including the categorical/status tokens copied verbatim from Ficus — against every one of Forest's OWN chrome surfaces (page/surface/surface-secondary/pill/surface-hover/inset). A fresh generator run needed **no contrast adjustments** in either appearance: `repairContrastPairs` reported `(no contrast adjustments)` for both `forest/light` and `forest/dark` — every token derived from the palette (and every token copied verbatim from Ficus) already cleared every gated pair without nudging. The full `builtins.test.ts`, `tokenCoverage.test.ts` and `utilityParity.test.ts` suites pass for Forest unchanged, no carve-out.

## BigBrain palettes

Source: the BigBrain project's own `web/ui/src/design/tokens.css`, which names three base colors per palette — a background (`bg`), a foreground/text color (`fg`), and an "activity" accent — plus the appearance it pairs that palette with. The six ported here (`packages/shared/src/bigbrain-palettes.ts`'s `BIGBRAIN_PALETTES`) are `nurebairo`, `phosphorus`, `yamabukiiro`, `moegiiro`, `adzukiiro`, `asagiiro`; BigBrain's own `light` and `og-web-blue` were dropped as near-duplicates of Ficus light / Ember light and OG web blue respectively, and are not built-ins.

Each becomes a genuine **unified** (constant-appearance) built-in — like High contrast, not a light/dark pair — generated by `apps/web/scripts/generate-bigbrain-builtins.ts` and baked into `apps/web/src/theme/builtins.css` between `GENERATED BIGBRAIN BUILTINS` markers (regenerate with `bun apps/web/scripts/generate-bigbrain-builtins.ts`; a freshness test in `apps/web/scripts/generate-bigbrain-builtins.test.ts` fails when the committed CSS drifts from a fresh run, mirroring the pre-paint flash script's own freshness test). The dark palettes (nurebairo, moegiiro, adzukiiro, asagiiro) keep the literal `dark` Tailwind migration class at their one constant appearance (`variantClass: { constant: 'dark' }` in `registry.ts`), the same bridge Ficus's own dark variant uses; the light ones (Phosphorus, yamabukiiro) use `{ constant: null }`, like High contrast.

### Generation

Existing built-ins establish (verified against the actual CSS) that only the `chrome` token family plus `--swatch-secondary`/`-tertiary`/`--on-accent-fg` actually vary between Ficus/Harbor/Ember/High contrast — every other family (status, agent-type, badge-decoration, voice-material, utility-decoration/-chrome, log-terminal, ansi, brand, and most of syntax/terminal/graph) is byte-identical across all of them, matching "two recolors [that] preserve status meanings and all seven used decorative Badge palettes." The generator follows that same precedent rather than recoloring everything:

1. Parses Ficus's own `:root`/`.dark` blocks in `index.css` into a token→value map (this is the derivation BASE, not a second runtime palette — built-ins still involve no runtime color generation).
2. Substitutes `--color-bg-page`/`--color-bg-surface` with this palette's own mixed values first, so the shared derivation's internal contrast pass (which nudges `--color-primary`'s lightness for 3:1 against the page) operates against what this theme actually ships, not Ficus's.
3. Runs the shared palette derivation (`deriveThemeOverrides`, the same pure engine `theme-derivation.ts` uses for custom themes) with `primary` = activity, `secondary` = bg, `tertiary` = fg, `neutral` = bg, `contrast: 'standard'`, `status: 'static'` — but applies its output ONLY to the restricted chrome/swatch/on-accent-fg set above; every other family is copied verbatim from Ficus.
4. Layers BigBrain's own sRGB `color-mix(in srgb, fg P%, bg)` formulas as explicit overrides on top of the core chrome tokens, winning over the derived value exactly like a custom theme's explicit `variants` win over palette derivation:

   | Token                                              | Formula                                                      |
   | -------------------------------------------------- | ------------------------------------------------------------ |
   | `--color-bg-page`                                  | `bg`                                                         |
   | `--color-bg-surface`                               | mix 4%                                                       |
   | `--color-bg-surface-secondary`, `--color-bg-inset` | mix 8%                                                       |
   | `--color-bg-surface-hover`, `--color-bg-pill`      | mix 10%                                                      |
   | `--color-input-bg`                                 | mix ~2%                                                      |
   | `--color-text-primary`, `--color-code-text`        | `fg`                                                         |
   | `--color-text-secondary`                           | mix 88% (nudged up per-theme if needed — see Contrast below) |
   | `--color-text-muted`                               | mix 65% (nudged up per-theme if needed)                      |
   | `--color-text-placeholder`                         | mix 50% (nudged up per-theme if needed)                      |
   | `--color-border`, `--color-input-border`           | mix 18%                                                      |
   | `--color-border-hover`                             | mix 28%                                                      |
   | `--color-code-bg`                                  | mix 6%                                                       |
   | `--color-selection-bg`                             | activity mixed 15% into `bg`                                 |
   | `--color-selection-border`                         | activity mixed 40% into `bg`                                 |

   `--swatch-secondary`/`--swatch-tertiary` are not set explicitly — the palette's own `secondary`/`tertiary` seeds (bg/fg) already derive them, so the swatch wheel blends primary→secondary→tertiary as BigBrain's own accent→bg→fg.

5. `--opacity-input-border` and `--opacity-panel-border` (the only two `--opacity-*` metadata entries whose companion color token these palettes touch) are set to 1, matching High contrast's own choice: like High contrast, these palettes render borders as solid mixed colors, not Ficus's translucent neutral-gray ones. Every other `--opacity-*` entry (the seven badge-decoration surfaces/hovers, the nine status roles' surface/badge-surface/badge-hover) is copied verbatim — it is an independent authored "how translucent should this render via an opacity utility" constant, not derivable from the color token's own stored channels (see `tokenCoverage.test.ts` and the `calc()` formula in `index.css`).

### Contrast

The strict built-in gate (`apps/web/src/theme/builtins.test.ts`'s `contrastPairs`) checks every foreground — including the categorical/status tokens copied verbatim from Ficus in step 3 above — against every one of this theme's OWN chrome surfaces (page/surface/surface-secondary/pill/surface-hover/inset), a broader check than the shared derivation engine's own internal pass. Since several of BigBrain's surfaces are noticeably more saturated/darker than Ficus's own neutral grays, some Ficus-tuned foregrounds fell short there. The generator's `repairContrastPairs` step corrects this — never by weakening a gate, and never by touching the shared derivation engine — by nudging ONLY that specific token's LIGHTNESS (hue/chroma held fixed, the identical bisection technique `theme-derivation.ts`'s own `contrastPass` uses) toward whichever extreme clears every gated pair for that one theme; if lightness alone can't reach the target even at the sRGB gamut extreme (a saturated hue that can't get light/dark enough without desaturating), it falls back to also reducing chroma toward gray at that extreme, same bisection technique. Per-theme, the tokens this actually moved:

| Theme       | Tokens adjusted                                                                            |
| ----------- | ------------------------------------------------------------------------------------------ |
| nurebairo   | `--scrollbar-thumb`                                                                        |
| phosphorus  | `--color-focus`, `--agent-type-{1–5}-fg`                                                   |
| yamabukiiro | `--color-focus`, `--scrollbar-thumb`, `--agent-type-{1–6}-fg`                              |
| moegiiro    | `--scrollbar-thumb`, all nine `--status-*-fg`, `--agent-type-{1–6}-fg`                     |
| adzukiiro   | `--scrollbar-thumb`, eight `--status-*-fg` (all but `review`), `--agent-type-{1,2,3,5}-fg` |
| asagiiro    | `--scrollbar-thumb`, all nine `--status-*-fg`, `--agent-type-{1–6}-fg`                     |

Every other token (including every badge-decoration and syntax-accent pair, and every text role after the mix-percentage bump above) already cleared its gate without adjustment. The full `builtins.test.ts` suite — the same 1.4.3/1.4.11 gate Ficus/Harbor/Ember/High contrast are held to — passes for all six unchanged (no carve-out).

## Strict contrast gate

Every built-in must pass the strict WCAG contrast gate and the cold-load matrix before it can ship. Ficus's default palette carries a narrow, deliberately authorized exception to exact legacy-color parity: six tokens are minimally corrected from their pre-gate values so Ficus itself clears the gate, while preserving its default selection and overall identity. No other contrast carve-out exists.

### Authorized Ficus deltas (worst applicable pair)

| Token                              | Previous channels             | New channels                  | Before → after ratio |
| ---------------------------------- | ----------------------------- | ----------------------------- | -------------------: |
| Muted and placeholder text (light) | `114 109 129`                 | `111 106 126`                 |        4.389 → 4.586 |
| Scrollbar (light, composited)      | `156 163 175 / 0.5`           | `55 65 81 / 0.65`             |        1.453 → 3.585 |
| Scrollbar (dark, composited)       | `156 163 175 / 0.5`           | `156 163 175 / 0.6`           |        2.621 → 3.178 |
| Syntax comment (both)              | `91.8 98.6 112.2`             | `141.8 148.6 162.2`           |        2.308 → 4.634 |
| Syntax property (both)             | `223.7625 107.7375 117.40625` | `226.7625 111.7375 121.40625` |        4.375 → 4.567 |
| Terminal-muted (both)              | `107 114 128`                 | `118 125 139`                 |        3.942 → 4.607 |

Only these token values change in Ficus. The syntax parity test explicitly substitutes the two authorized inks; all other syntax styles, ANSI/terminal slots, status and decorative palettes retain their parity checks. The dark muted/placeholder text remains unchanged.

The gate checks every text/UI-accent/focus/scrollbar/graph-link pair per concrete palette with sRGB WCAG luminance, fractional channels, foreground alpha and surface alpha × intrinsic-opacity metadata. Text requires 4.5:1; focus, scrollbars and graph links require 3:1. Covered: four text roles on six chrome surfaces, inline code, nine status roles and hover badges, seven decorative badge palettes, six agent identities, all syntax inks on both code surfaces, terminal text/muted/cursor, accent button states and graph labels/links. Status/badge translucent surfaces are composited over every likely underlying chrome surface. Every built-in — Ficus, Harbor, Forest, Ember, High contrast and the six BigBrain ports — clears the gate with zero failing pairs; see each theme's own section above for its generator and any per-token contrast repairs.

These are defined-token-pair checks, not certification of every rendered page, text opacity utility, terminal SGR combination or third-party chart scheme.

## Cold-load matrix

The shipped inline script contains a minimal surface map, checked against the registry and actual CSS, so missing/corrupt/stale snapshots and an OS scheme flip cannot paint a default white surface over a stored dark/recolored theme. A matching state-keyed snapshot still wins. Unknown IDs retain the Ficus fallback. Unified themes omit data-appearance and remove the dark migration class.

- Unit matrix: every built-in × each appearance setting (Light/Dark/System) × both OS color schemes × the snapshot cases (missing, corrupt, stale, matching).
- Provider matrix: the same dimensions, plus interaction coverage of unified → dual preference retention.
- Chromium: the actual shipped HTML with the application module blocked (no React/CSS assistance), across appearance setting × snapshot case. This was run by hand on Ficus, Harbor, Ember and High contrast; later built-ins rely on the unit and provider matrices. Document scope, dark class, background and theme-color all matched before hydration.

A real-renderer Chromium fixture (synthetic local data) exercised the surfaces below for Ficus, Harbor, Ember and High contrast in each appearance, without uncaught browser errors. This is not authenticated application navigation or a live service/session test.

| Requested surface          | Actual paths reviewed in each theme/appearance                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Feed / work streams        | `FeedPage`, real `WorkStreamList` rows, status and decorative `Badge`s; pending-action source is synthetic and visit-summary is omitted          |
| Chat / tools / code / ANSI | Real `MarkdownContent`, bash `ToolArgsView`/`ToolResultView`, `AnsiText`                                                                         |
| Squads / graphs            | Real `OrgGraph` and `AgentVisualization` 2D canvases; additional real 3D switch; mounted graph canvas retained across theme switches             |
| Settings                   | Real `ThemeControl` with `ThemeProvider`; full Settings navigation covered by component suites, not authenticated browser navigation             |
| Voice                      | Real `VoiceWorkspacePage` with a deterministic listening hook, no microphone/network session                                                     |
| Presentation / file viewer | Real `PresentationRenderer` with Vega-Lite chart and `FileViewer` with a TypeScript file                                                         |
| Terminal                   | Real xterm, `readTerminalTheme` and root observer; theme changes repaint the existing terminal without discarding it; no remote shell connection |

**Unverified:** successful `SquadUniverse` WebGL rendering (an inherited tick/layout initialization failure, already reproduced on the predecessor and its baseline), authenticated full-page flows, physical iOS Safari/PWA cold launch, Windows hardware high-contrast rendering, and arbitrary artifact-authored palettes. The complete-coverage guard (see [complete coverage](complete-coverage.md)) retains only its explicitly bounded content/definition exceptions.

## Forced-colors checklist

This was reviewed by hand on Ficus, Harbor, Ember and High contrast. The forced-colors rules are theme-independent.

- [x] Chromium forced-colors emulation with reduced motion and reduced transparency: author inset shadows disappear; primary buttons still have a system-color boundary and focus outline.
- [x] Native selectors retain labels and focus; unified appearance is disabled with explanatory text.
- [x] Voice gradient layers may flatten/disappear; orb has a real system-color outline and its status is displayed as text (`Listening`), rather than relying on glow/dots.
- [x] No `forced-color-adjust: none` escape is introduced; built-in/custom theme colors are cosmetic under the user's forced palette.
- [ ] Physical Windows high-contrast / assistive-technology pass (not performed).

The browser review caught the existing `voice-orb-status { display: none }`; the forced-colors rule explicitly restores its display, hides decorative dots and exposes its accessible label visually. A color/box-shadow-only fallback would have missed this.
