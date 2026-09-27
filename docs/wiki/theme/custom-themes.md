# Custom themes and the theme preset library (v2)

Settings → Appearance → **My themes** is a per-user library of saved theme
presets (`/api/theme-presets`). Each preset covers **both light and dark**
(or one constant variant for a unified base like High contrast), so applying
a preset follows the existing Light/Dark/System toggle instead of locking the
app to one concrete appearance. **New**, **Duplicate**, **Edit**, **Rename**,
**Delete** (with confirmation), **Use**, **Share/Unshare** and
**Export/Import** all operate on this library. Editing a preset opens a token
editor whose draft previews **live on the whole app** (not a scoped sample)
while it is open; nothing is persisted until **Save** (existing preset,
revision-checked `PUT`) or **Save as new** (`POST`, forking a copy); closing
without saving restores the previously applied selection.

## Sharing

Any signed-in user can share one of their own presets with everyone else on
the instance, and unshare it again — a preset's `visibility` is `'private'`
(default) or `'instance'`, toggled by its owner via
`PUT /theme-presets/:id/visibility` (revision-checked, like the document
update route; never touches the document itself). Settings → Appearance →
**Shared themes** lists every OTHER user's `'instance'`-visibility preset
(`GET /theme-presets?scope=shared`; `scope=mine` — the default
behavior — or `scope=all`, the union, are also available), each with a swatch,
its name, **"by {owner}"** attribution, **Use** and **Duplicate**. Every
`ThemePreset` DTO carries `owner: { id, displayName }` (`displayName` is the
account's display name, falling back to its email — the same
display-name-or-email convention Core's other cross-user attributions, like
chat sender names and work-stream requester names, already use; there is no
separate raw `email` field on this DTO).

**Use** on a shared preset is a **live link**: the active selection
references that preset by id, not a copy of its document at that moment. The
author's later edits show up automatically — `GET /theme-presets/:id` is a
live-link read that returns the caller's own preset OR any `'instance'`
preset (a private preset owned by someone else is still a 404, indistinguishable
from a missing id); the browser refetches it on load and on the same
focus/online/visibility triggers as account preference sync (see
[account sync](account-sync.md)), and applies the new document through the
normal apply path if it changed (so the resolved snapshot, pre-paint cache and
account sync all stay consistent) — never overriding an open editor draft or
quick-picker hover preview, which live in a separate preview slot layered on
top of whatever is currently applied. If the preset is unshared or deleted,
the fetch 404s: the user keeps their last-seen copy (the already-applied
document snapshot) and Settings shows it as **detached** ("This shared theme
is no longer available — keep a copy to keep using it"), with a **Keep a
copy** action that saves it into the user's own library as an ordinary new
private preset.

**Duplicate** (`POST /theme-presets/:id/duplicate`) works identically for the
caller's own presets and any shared preset: it copies the document into a
new, independent, always-**private** preset in the caller's own library named
`"Copy of <original name>"` (truncated to the 40-character name limit),
enforcing the DUPLICATING user's own 50-preset cap — never the source
preset's owner's cap, and never the source's own visibility.

An admin or operator holding the `theme-presets:moderate`
[permission](../permissions.md) can remove any preset from the shared list —
`DELETE /theme-presets/:id/share` —
without deleting it: the preset simply reverts to `'private'` and stays in
its owner's own library, exactly like the owner unsharing it themselves. An
already-private or missing preset is a harmless no-op/404, never a fake
success. There is no separate audit-log table for this action (the codebase
has no generic moderation audit log — see `services/rbac/audit-actor.ts`);
the route logs the acting identity via the existing `auditActor` convention.

`presetId` alone is enough to identify a foreign preset unambiguously (it is
a globally unique UUID), but `ThemePreference` (the account-synced selection,
see [account sync](account-sync.md)) also carries `presetOwnerId`: it is
populated whenever ANY preset (own or shared) is applied, and — unlike
`presetId` — is deliberately RETAINED when the live-link refresh clears
`presetId` on a 404. That retained pair (`presetId: null`,
`presetOwnerId: <id>`) is what lets Settings show "no longer shared" for a
detached SHARED preset while keeping the silent, message-free detach
for the caller's own deleted preset (whose `presetOwnerId` equals the
caller's own id, so the "foreign" check never fires). The quick picker
(`ThemeQuickPicker`) stays compact: rather than a whole shared gallery, it
adds at most one extra circle — for the CURRENTLY active preset, if it isn't
already in the caller's own list — synthesized directly from this same
provider state, with no extra fetch.

```json
{
  "format": "tau-custom-theme",
  "version": 2,
  "name": "My night theme",
  "base": "harbor",
  "palette": { "primary": "#0ea5e9", "contrast": "standard", "status": "static" },
  "variants": {
    "light": {},
    "dark": { "--term-bg": "rgb(12, 20, 30)" }
  }
}
```

A v1 document (`version: 1`, one concrete `appearance` + `overrides`) still
loads everywhere: `validateCustomTheme` normalizes it into a v2 document with
the opposite dual side empty (or into a single `constant` variant for a
unified base). There is no user-visible "upgrade" step; the normalized v2
shape is what gets saved back on the next edit.

## Seed-color derivation (`palette`)

Hand-editing dozens of tokens per variant is tedious, so a preset can instead
set a handful of seed colors and let most tokens derive automatically. A
preset created from a built-in with no `palette` behaves exactly like a
plain explicit-override document; setting a `primary` color starts
derivation. `variants` stay available as an **advanced**, always-on-top
layer: explicit per-token overrides apply _after_ derivation and win on
conflicts, exactly like today's token list and status-grid picker (now
tucked under an "Advanced" section once a palette is set).

The editor is seeds-first: a top-level "Palette" panel exposes Primary /
Secondary (optional) / Tertiary (optional) / Neutral (optional) color
**fields** — each a native `<input type="color">` swatch button paired with
the hex/`rgb()`/`rgba()` text field (the source of truth; alpha stays
text-only, the swatch always shows the opaque hex) — a Contrast segmented
toggle (Standard/High) and a Status colors segmented toggle
(Static/Harmonized), all live-previewing the whole app immediately. All four
seed fields always render; a seed set before Primary starts the palette from
the base theme's own primary. Setting Primary fills a blank Secondary and
Tertiary with `suggestPaletteSeeds` (analogous +30°, split-complementary
+150°), and they follow Primary while they still equal its companions. An unset
optional seed shows a placeholder swatch reading the active base theme's own
`--color-border` token off the live cascade (never a hardcoded color — see
the no-raw-colors guard), "Not set" in its text field, and no Clear button;
setting one adds a Clear button that empties it back to unset. Clearing Primary drops the palette back to a plain
explicit-override document. **Based on** (the base theme) sits beside the
theme name, with a note on what the base supplies; New theme starts from the
theme in use. Everything else from before (the Light/Dark variant tabs, the token-by-token Color token/Color value editor,
the override list, and the contrast-warnings/safe-value panel) moves into a
collapsed `<details>` "Advanced: per-token overrides" section, reachable at
any time — a palette and explicit overrides are never mutually exclusive.

```ts
palette?: {
  primary: string          // required once `palette` is present
  secondary?: string       // default: primary hue rotated +60°
  tertiary?: string        // default: primary hue rotated +300°
  neutral?: string         // tint for chrome/surfaces; default: primary hue at very low chroma
  contrast?: 'standard' | 'high'   // WCAG target for the contrast pass below; default 'standard'
  status?: 'static' | 'harmonized' // default 'static'
}
```

Derivation (`packages/shared/src/theme-derivation.ts`, pure — no DOM, a small
in-house sRGB↔OKLCH conversion in `color-oklch.ts`) maps every active token
into one of these buckets, keyed off `THEME_TOKEN_FAMILIES`:

| Bucket                             | Tokens                                                                                                         | Rule                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Neutral/chrome                     | Backgrounds, text, borders, inputs, shadows, overlays, scrims, terminal/log **backgrounds**                    | Hue/chroma replaced by the neutral tint; **lightness and alpha preserved** from the base token, so the base theme's own contrast structure carries over.                                                                                                                                                                                                                                                              |
| Primary/accent                     | `--color-primary(-hover/-active/-light)`, selection bg/border, focus ring                                      | Derived from the `primary` seed with a **lightness offset** and **chroma ratio** modeled on how that same token differs from the base theme's own `--color-primary` (so "hover" stays proportionally lighter than the seed the same way it is in Tau).                                                                                                                                                                |
| Interaction surfaces (secondary)   | Hover, pill, inset, secondary surface, selection bg/border                                                     | With a `secondary` seed: its hue at the base lightness, chroma capped as a tint (as Harbor/Ember tint theirs). Without one, the neutral/primary rules above.                                                                                                                                                                                                                                                          |
| Ink                                | `--on-accent-fg`                                                                                               | Chosen as pure black or white by contrast against the _final_ primary (after the contrast pass below, not before — see there), not hue-derived.                                                                                                                                                                                                                                                                       |
| Brand/voice                        | Brand gradient/tile/ink, voice-material glows                                                                  | The tertiary hue; base lightness/chroma preserved.                                                                                                                                                                                                                                                                                                                                                                    |
| Swatch                             | `--swatch-secondary`, `--swatch-tertiary` (the colours theme swatches blend with the primary)                  | The palette's own secondary and tertiary; when unset, their colour-theory companions from the primary (`suggestPaletteSeeds`: +30° / +150°). Built-ins define their own.                                                                                                                                                                                                                                              |
| Categorical                        | agent-type, badge-decoration, graph chart categories/links, a curated syntax-accent subset, utility-decoration | Hue picked from primary/secondary/tertiary by slot index; base lightness/chroma preserved.                                                                                                                                                                                                                                                                                                                            |
| Status (`static`, default)         | The 162-token status grid                                                                                      | **Untouched** — absent from the derived overrides, so it keeps inheriting the base theme's own values. Semantic meaning (danger=red, success=green, ...) is never reassigned by a palette.                                                                                                                                                                                                                            |
| Status (`harmonized`)              | Same grid                                                                                                      | Each role's hue is bounded-shifted (≤22°, and clamped to never cross halfway into a neighboring role's own hue — roles cannot swap identities) toward whichever seed color is angularly nearest, chroma blended 30% toward that seed; **lightness stays per-step** so the ramp's contrast structure holds. Editor: a "Status colors: Static / Harmonized" toggle in the palette section, with live whole-app preview. |
| ANSI-named terminal/log/ansi slots | `--term-red`, `--log-blue`, `--ansi-*`, ...                                                                    | Unchanged — these name a specific color by convention, independent of the palette.                                                                                                                                                                                                                                                                                                                                    |

After derivation, a **contrast pass** nudges a small set of critical derived
pairs by moving **lightness only** (never hue or chroma), via bisection
against the fixed background:

- `--color-text-primary`/`--color-bg-surface` and `--color-text-secondary`/
  `--color-bg-surface` — body text, held to the **text** WCAG target (4.5:1,
  or 7:1 for `contrast: 'high'`).
- `--color-primary`/`--color-bg-page` — a **UI accent** (buttons, borders,
  icons), not body text, so it is deliberately held to the lower **non-text**
  WCAG 1.4.11 target instead (3:1, or 4.5:1 for `contrast: 'high'`). Text-level
  contrast for content painted ON the accent is `--on-accent-fg`'s separate
  job; using the text target here was an earlier bug — it forced a bright,
  valid seed color to darken far more than a user choosing it as their brand
  color would expect (a saturated sky blue against a near-white page could
  come out murky and washed-out). A regression test holds this pair to its
  own (lower) floor and asserts it never gets pulled toward the text floor.
- Harmonized status `fg`/`surface` and `badge-fg`/`badge-surface` pairs (all
  nine roles) — the text target, same as body text. `static` mode leaves
  these tokens out of the overrides entirely, so this pass never touches
  them there.

`--on-accent-fg` (black or white) is chosen **after** the contrast pass
above, against the **final**, possibly-nudged `--color-primary` — not the
freshly-derived, pre-pass value. Picking it earlier was an earlier bug: the
pass can still move `--color-primary`'s lightness for its own (UI) floor
after ink was already chosen, leaving the ink stale against what actually
ships (observed as low as 3.97:1 for a real base + seed + `contrast: 'high'`
combination, against a >5:1 achievable value). For any _fixed_ background,
the better of pure black/white text always clears ≈4.58:1 (the minimum,
at the luminance where both candidates tie) — comfortably over the
**standard** 4.5:1 target by construction, so no further nudge is ever
needed there. The **high** (7:1) target is not guaranteed by construction:
when neither black nor white reaches it against the final primary, this
additionally nudges `--color-primary`'s lightness (hue/chroma held fixed,
same bisection shape as the pass above) toward whichever extreme lets one
of them pass, preferring whichever candidate needs the smaller move. A
property-style test sweeps dozens of seed colors, in both appearances, and
asserts every built-in critical pair — including this real ember/dark
regression case — still clears its target.

Derivation needs the base theme's own resolved token values (to preserve
lightness/chroma/alpha), which only exist in the CSS cascade — matching the
"no copied runtime palette" rule this file has always followed. `apps/web`
supplies them via `getComputedStyle` once the built-in CSS has painted, then
`compileCustomTheme(doc, appearance, baseTokens)` merges derived-under-explicit
before compiling. Both the "My themes" library rows and `ThemeQuickPicker`'s
circles paint their swatch this same way — a scoped `[data-theme-scope]`
element gets the base classes, `applyCustomTheme` derives from THAT element's
own cascade, and the shared `.theme-swatch` CSS class (a static conic-gradient
over `--color-primary`/`--color-primary-hover`/`--color-bg-surface-secondary`,
not per-instance inline color) paints it — so a palette-derived preset's
swatch was never literally empty, but it WAS blank in the library specifically
until this class was applied there too (an oversight fixed alongside the
contrast-pass bug above; both are covered by dedicated regression tests).

This derivation-from-computed-style is unavailable in the **synchronous
pre-paint flash script**, which cannot trust the cascade that early (the same
reason it has always kept a small hardcoded surface-color fallback table
instead of reading computed style). Instead, `ThemeProvider`'s own real root
paint persists a **resolved snapshot** — `localStorage['ficus-custom-theme-resolved']
= { docHash, fingerprint, sides }`. `docHash` is a deterministic (FNV-1a,
staleness-detection only) hash of the exact document; `fingerprint` is a
**build-time** FNV-1a hash of `index.css`'s + `builtins.css`'s own content,
injected identically into the main app bundle (`vite.config.ts`) and the
separately-bundled pre-paint script (`generate-theme-flash.ts`) via a shared
`theme/fnv.ts`, so a deploy that changes a built-in token's own value
invalidates every previously persisted snapshot rather than serving a stale
derived color (`theme/builtinFingerprint.ts`); `sides` maps each resolved
appearance ('light'/'dark', or 'constant' for a unified base) that has
actually been painted to the exact compiled `--token`/`--custom-rgb-*`/
`--custom-alpha-*` map `applyCustomTheme` wrote for it. **Both** resolved
sides of a dual-base palette document can be present at once: a
`'system'`-appearance user's OS preference can flip between this real paint
and the next cold load, so `ThemeProvider` also derives the currently
non-visible side off-screen (a detached, zero-size, `visibility:hidden`
`[data-theme-scope][data-theme][data-appearance]` probe — the same
attribute-scoping the built-in CSS already defines for nested previews) and
merges it into the same snapshot; gated on the document having a `palette`
on a dual-kind base (an explicit-only document's other side needs no
cascade/derivation at all, and a unified base has no other side), so the
extra work only happens when it can actually pay off.

On the next cold load, the flash script applies the snapshot directly
(`root.style.setProperty` for each entry, filtered to registry-owned
property names, and further filtered to the exact compiled channel grammar
— see "Validation and application boundary" below) whenever `docHash` and
`fingerprint` both match and `sides` has an entry for the currently-resolved
appearance — this is what lets a palette preset paint its fully derived look
before CSS/React, instead of flashing the plain base theme. A miss (the
document was edited since the last real paint, a deploy changed a built-in
token, the OS/appearance flipped to a side nothing has snapshotted yet, or
there is no snapshot at all) falls back to the explicit-overrides-only path
as before; the very next real repaint derives fully again and refreshes the
snapshot (merging with, not discarding, whichever OTHER side's entry is
still valid for the same doc/build). `clearCustomTheme` clears this key
alongside the document itself. The snapshot is capped at 200 KiB (a full
palette+harmonized-status theme, BOTH sides, measures well under 180 KiB in
practice) and is written only for the ACTIVE document, never a library
preset that isn't currently applied. Persisting on a storage-event-driven
repaint (another tab changed the selection) is harmless, not just redundant:
the derived vars are a pure function of (doc, base tokens), so every tab
computes the identical value for the same (doc, appearance) pair, and the
snapshot key is never one of the keys the cross-tab storage listener reacts
to, so writing it can never itself trigger another repaint (no feedback
loop).

## Validation and application boundary

- `packages/shared/src/custom-theme.ts` owns the dependency-free schema, validator and compiler. Input is capped at **32 KiB UTF-8 before parsing**, including whitespace — up from 8 KiB because a v2 pair can carry a FULL light+dark override of every active token at once (a v1 document only ever needed one side of the grid); the cap is sized against a measured worst-case full-pair document (`#rrggbbaa` values on every token, both variants, a 40-character name — see the "worst-case pair" test). Override count per variant cannot exceed the token registry count. Names are 1–40 Unicode code points and rendered only as text.
- Values accept `#rgb`, `#rrggbb`, `#rrggbbaa`, comma-form `rgb()` with integer channels 0–255, or `rgba()` with integer RGB and alpha 0–1 (fractional alpha is supported); this closed grammar covers explicit overrides AND palette seed colors. No named colors, percentages, fractional RGB input, CSS references, URLs, comments, declarations or arbitrary functions are accepted.
- Unsupported versions are refused with an explanation; both `version: 1` and `version: 2` are accepted on read, `version: 2` is the only write shape. Unknown/inactive tokens are warned about and discarded per variant; their values still undergo the same safety checks. Unknown top-level fields (including a stray v1 `appearance` on a v2 document) are not persisted in the normalized document.
- Any status override requires the **entire 162-token grid** (nine roles × (seven semantic slots + eleven tone steps)), validated **independently per variant** before inheritance — the same rule as v1, just applied to light and dark separately. Imports must supply it explicitly for whichever variant(s) they touch.
- Every application revalidates: `applyCustomTheme(element, doc, appearance)` re-runs `validateCustomTheme` before compiling, then writes only individually validated, registry-owned properties through `style.setProperty`; no custom CSS/HTML text is assembled. Static built-in CSS scopes also match the preview element, preventing inherited root overrides from contaminating the preview base.
- Colors retain their full channels/alpha for ordinary CSS and graph/xterm readers. Compiler-owned `--custom-rgb-*` and `--custom-alpha-*` properties let opacity-modified utilities multiply **custom alpha × intrinsic alpha × utility opacity** without invalid double-slash RGB syntax. Imports cannot set these helper names or intrinsic metadata. Preview scopes explicitly mask inherited helpers; reset removes them from the root.

Concrete graph/chart and interactive/log-terminal adapters expand JavaScript exponent notation to plain decimal color arguments. This preserves tiny numeric alpha and intrinsic-alpha products for the actual dependency parsers without rounding them to opaque. xterm quantizes colors to eight-bit channels; its existing opaque-selection policy still uses 30% selection opacity. These renderer rules do not broaden the accepted import grammar.

## The editor's whole-app live preview: the preview slot

The preset editor (`CustomThemeEditor`, opened from **My themes**) and
`ThemeQuickPicker`'s hover preview both paint a draft/candidate directly onto
`document.documentElement` — the same pure-DOM `paintRoot` path (factored
into `theme/preview.ts` so both share it) — instead of a scoped sample div.
For a dual base the editor exposes Light/Dark tabs that each preview and
edit their own variant independently; a unified base has no tabs. Opening
the editor never persists anything; **Save**/**Save as new** are the only
writes.

Both preview UIs register through a single **preview slot** `ThemeProvider`
owns (`useThemePreview()`/`setPreview(painter)`, `providers/ThemeProvider.tsx`)
rather than calling `paintRoot` directly. `setPreview` stores the painter,
paints it immediately, and returns an unregister function; `ThemeProvider`'s
own root-paint effect reapplies whichever painter is currently registered
**after its own real paint, every time it paints** — so an open preview
survives ANY unrelated repaint (the app's Light/Dark/System control, a
storage event from another tab, remote account-sync adoption), not just the
one that happened to be racing it at mount time. Only one preview is ever
active (last registrant wins); the unregister function repaints the current
real selection, but only if it's still the registered painter, so a stale
hover-preview cleanup (e.g. the pointer leaving a quick-picker circle AFTER
the editor already opened) can never clobber a newer registration. Closing
the editor — Cancel, Save success, or simply unmounting — unregisters its
painter, which is exactly what restores the previously applied selection;
there is no separate restore path to keep in sync.

(This replaces an earlier `queueMicrotask`-based ordering hack that
exploited React firing layout effects child-before-parent — fragile because
it only ever won the race against the ONE repaint that happened to be
in-flight at mount time, not against a repaint triggered later by something
else entirely while the preview was still open.)

The saved key is `ficus-custom-theme`; a device-local `ficus-theme-preset-id` key
remembers which library preset the active document came from (or is absent
when detached — a built-in selection, a one-off import, or the preset's own
row was later deleted; the applied document snapshot keeps working either
way). Invalid saved documents are removed with stale surface snapshots, and
the declared known base is restored (otherwise the last safe built-in
selection). Application failure removes partial overrides and restores the
base without reloading. Denied storage is best-effort: the in-memory theme
works, and the UI explains when persistence is unavailable.

The synchronous pre-paint bootstrap uses the **same validator and compiler**
as React (minus palette derivation, see above). It applies validated
explicit overrides before CSS/React, derives its custom surface from the
document rather than a stale snapshot, and performs the same recovery.
`apps/web/index.html` contains generated code; regenerate after changing its
dependencies:

```sh
bun apps/web/scripts/generate-theme-flash.ts
```

A test compares the shipped script to a fresh bundle under the pinned Bun version, alongside built-in and custom cold-load matrices (v1 and v2, light/dark/system). This adds no runtime dependency.

## Contrast tooling (per-variant, in the editor)

The editor reuses the built-in contrast computation and critical-pair inventory for whichever variant tab is open, including fractional channels and intrinsic opacity. Failing pairs show informational ratios and a **Use safe value** action choosing opaque black or white foreground against the completely composited surface. Other surfaces and islands are checked over the whole-app page/surface, with explicit status/badge under-surfaces resolved recursively. An opaque layer ends the chain. A translucent page with no known opaque foundation is reported as **Contrast unknown**, with no safe-value recommendation for that pair. Ratios and suggested values use the same resolved backdrop; tiny alpha values retain scientific notation numerically. Warnings never block Save. A safe value improves the named pair, not a certification of every use of that token; other warnings may remain. Arbitrary ANSI combinations, authored content and arbitrary utility-tone pairings are not certified.

## Assistant

Editing a theme (new or existing) shows a co-editor conversation beside the token
editor, gated on `chat:send` like the workflow builder's assistant — see
[voice-assistants.md](../voice-assistants.md#assistants-embedded-in-editors) for
the shared page-editor framework this attaches to. **My themes → New theme**
opens the editor with that panel focused (when the user has `chat:send`; a
no-op otherwise, so there is only ever one "New theme" action); **Edit** opens
the same panel without moving focus to it.

The assistant is palette-first: it mostly edits `palette.primary` /
`secondary` / `tertiary` / `neutral`, `palette.contrast`
(`'standard'`/`'high'`) and `palette.status` (`'static'`/`'harmonized'`) —
the same seed fields the Palette panel exposes — rather than walking
individual tokens. Its edit operations are `set-palette` (patch or clear
seeds/contrast/status; `primary: null` clears the whole palette),
`set-overrides` (advanced per-token overrides on one variant; `null` removes
a token), `set-base` (change the base theme, reshaping `variants` for its
kind), `rename`, and `clear-overrides`. Requests like "warmer", "teal
accent", or "higher contrast" become a `set-palette` patch; "make the dark
side deeper" becomes a `set-overrides` call on the `dark` variant. It keeps
status colors `'static'` (their built-in meaning) unless asked to match the
palette, and only raises `contrast: 'high'` when asked for more contrast or
accessibility.

Edits apply automatically to the open draft and repaint the whole app live,
through the same preview slot as manual edits — there is no separate Apply
step, and the assistant cannot save or publish; **Save**/**Save as new**
still require the user. Manual token/palette edits and assistant edits share
one undo/redo history (Undo/Redo buttons beside the editor, and the
assistant's own `historyAction` edits), exactly like the workflow builder.

Because the editor lives entirely in the browser (derivation runs against
the live CSS cascade, not a server-side renderer), the assistant cannot see
the rendered result by reading the document alone. The web host computes
**insights** — resolved key colors (`primary`, `surface`, `page`, `text`,
`border`, `onAccent`, `danger`, `success`, as hex) and any WCAG contrast
warnings for the currently-painted variant — from the same paint pass that
already checks contrast for the Advanced panel, and syncs them alongside the
draft so a `read` returns them without an extra round trip. This lets the
assistant judge whether an edit actually achieved what was asked (e.g.
confirm "warmer" moved the resolved primary's hue) instead of reasoning from
seed colors alone.

`include: ["contract"]` on `read` returns the token catalog (families +
descriptions + the full active token name list, for `set-overrides`) and the
built-in base list — omitted by default, since ordinary palette edits don't
need it.

## Regression coverage

- Shared: closed grammar/rejection, byte/count caps (including the worst-case-pair measurement), unknown-name and pre-inheritance coherence per variant, v1→v2 normalization, `compileCustomTheme`'s resolved-variant selection, OKLCH round-trip fidelity (`color-oklch.test.ts`), derivation buckets + harmonized-status bounding + the multi-seed contrast-pass property test in both a light and a dark real-base fixture, including a dedicated regression test holding the primary/page pair to the non-text (3:1) floor rather than the text (4.5:1) one, a concrete real-base (ember/dark) regression for `--on-accent-fg` being chosen against the final (post-pass) primary rather than a stale pre-pass one, and harmonized status fg/surface + badge-fg/badge-surface pairs actually being included in the contrast pass (`theme-derivation.test.ts`), preset request-schema/cap and per-owner-race/non-UUID-:id tests, the visibility-change request schema and the `mine`/`shared`/`all` scope guard (`theme-preset.test.ts`), and `presetOwnerId`'s optional/only-alongside-a-document validation, including the detached-shared combination (`presetId: null`, `presetOwnerId` retained) (`theme-preferences.test.ts`).
- Core: owner-scoped preset CRUD (`GET/POST /theme-presets`, `GET/PUT/DELETE /theme-presets/:id`) — isolation, revision conflicts (409), validation (422), per-user cap (409, race-safe under real concurrency via a per-owner `pg_advisory_xact_lock` — a 20-way concurrent create from 49 lands exactly 1 more, never over the cap), a malformed `:id` is a 404 (never a raw driver error), cascade on user deletion, and the generated `theme_presets` migration; sharing — `scope=mine/shared/all` isolation (a private preset never appears in another user's `shared`/`all`), owner attribution on every returned preset, the live-link `GET /:id` read (own OR any `'instance'` preset; unshared/deleted is a 404 again), owner-only revision-checked `PUT /:id/visibility`, `DELETE /:id/share` denied without `theme-presets:moderate` and idempotent/404-correct with it (the owner keeps a private copy), and `POST /:id/duplicate` for both own and shared sources enforcing the DUPLICATING user's own cap (`theme-presets.test.ts`).
- Web: custom preview isolation and complete inheritance, invalid-document fallback, export round trip (import now lives once, in the library), partial-application cleanup, graph/xterm observer repaint and reset, a real-CSS-cascade palette-derivation integration test (explicit overrides still win over derived values), the resolved-snapshot round trip and staleness rules (matching doc+fingerprint+appearance applies pre-paint; an edited doc, a different build, or the other appearance falls back; a hostile/malformed snapshot value is never trusted — the WHOLE snapshot is rejected, not partially applied; a full palette+harmonized-status snapshot, BOTH sides, stays well under budget) in both `theme/custom.test.ts` and `theme/flashScript.test.ts` (the shipped script, not just the source), `ThemeProvider` tests that a real root paint persists a snapshot matching the applied document and clears it on deactivation, and that a `'system'`-appearance palette preset snapshots BOTH resolved sides (with a real pre-paint `readResolvedSnapshot` check on the non-visible side), the preview slot (last registrant wins; a superseded registrant's clear never clobbers the current one; the editor's live preview survives an appearance change, a storage event, and remote account-sync adoption made elsewhere while it's open) in `ThemeProvider.test.tsx` and `CustomThemeEditor.test.tsx`, the editor's whole-app live preview (open/tab-switch/Cancel/unmount all repaint or restore correctly), an unset seed swatch reading the active base theme's own `--color-border` token rather than any hardcoded color, color-field accessibility (swatch and text field are independently addressable, not ambiguously co-labelled), the preset library's New/Duplicate/Rename/Delete/Use/Export/Import flows, a real-built-in-CSS test that a palette-only preset's library swatch and quick-picker circle both resolve a recognizably-derived color (not empty, not the plain base), `ThemeQuickPicker` rendering one circle per saved preset (in addition to the built-ins) with a selection ring keyed on the active preset id, and the theme-presets query being gated identically (an auth-disabled instance sees presets in both) between `AppNav` and `ThemePresetLibrary` via a single shared `selfServiceQueryEnabled`; sharing — `ThemeSyncStore.refreshLinkedPreset`'s no-op/apply-if-changed/404-detach/network-silent/stale-response-discarded behavior and `presetOwnerId` round-tripping through `change`/reload (`theme/sync.test.ts`), the live-link fetch sequenced after (not racing) the account preference read and re-triggered on the same focus/online/visibility events (`ThemeAccountSync.test.tsx`), the Settings **Share/Unshare** toggle, **Shared themes** listing with attribution, admin-only **Remove from shared** (confirmed, permission-gated) and the detached-shared **"Keep a copy"** notice (`ThemePresetLibrary.test.tsx`), and the quick picker's single synthetic circle for an active foreign preset not already in the caller's own list (`ThemeQuickPicker.test.tsx`).
- Actual generated utility substitution covers all mapped tokens with custom alpha and intrinsic/utility opacity; built-in palette parity and contrast gates remain unchanged.
- Security source checks prohibit CSS/HTML text writes in the custom application path; pre-paint generation cannot drift from the shared validator/compiler.

Physical-device/PWA cold-launch and authenticated account navigation are not certified by these tests. The inherited Universe fixture/layout limitation remains outside this change.
