# Content color adapters

The registered theme's resolved CSS scope is the source of truth for all colors
(`index.css`). The syntax object references variables directly, so changing the
resolved appearance updates mounted blocks without a hook, duplicate JS palettes,
or a first-render fallback. Iris keeps its dark syntax and terminal palettes in **both** appearances; the strict
contrast gate minimally raises comment/property and terminal-muted ink for contrast. Streamed
ANSI retains its distinct light/dark palettes. Additional built-ins define their
complete scopes in `builtins.css`; see [built-in intent, gates and matrix](../../../../docs/wiki/theme/builtins.md).

## Compatibility contracts

- `syntax.ts` owns the inline selectors supported by react-syntax-highlighter.
  The previous oneDark typography, token grouping and emitted classes are
  preserved, including empty entries for class filtering formerly caused by
  unused Prism-plugin selectors. Fractional RGB channels preserve the original
  HSL values rather than approximating them by integer hexes. Memory code and
  image-preview framing keep their separate backgrounds; image content is not
  recolored.
- `terminal.ts` converts channels to concrete comma-form RGB(A) for xterm 5.5.
  The constructor reads the applied root before `open()`. A root attribute
  observer updates the existing instance after theme, appearance or inline token
  overrides change; it does not reconnect a socket or discard scrollback.
- `--term-selection-foreground: none` is a deliberate sentinel: omit xterm's
  selection foreground override, retaining the selected cells' individual ANSI
  ink. A theme can instead supply RGB channels.
- xterm **5.5 has no scrollbar fields in `ITheme`**. The three scrollbar tokens
  default to `auto`, leaving the existing native scrollbar unchanged. To opt into
  themed viewport scrollbars, supply RGB channels for all three thumb states;
  the adapter enables the CSS rules. Iris’s hover/active tokens alias the normal
  thumb, so a partial override of just that thumb also stays valid. This is not a
  dependency upgrade.
- `--term-*` and `--ansi-*` use the same sixteen slot **names**, not identical
  values. Aliasing their legacy palettes would visibly change one surface. Hue
  tests keep red red-ish, green green-ish, and so on, including bright slots.
- ANSI background classes preserve the existing cascade. In particular, light
  colored backgrounds do not override an explicit SGR foreground. The `.dark`
  rules select the contrasting `--ansi-on-*` ink as before; their values are
  themeable, not literals. `AnsiText` and the escape-code parser are unchanged.
- Supporting tokens cover the remaining literal colors in the five migrated
  components (human markdown, file errors, terminal skeleton/disabled text).
  `--syntax-shadow` is CSS-only and retains embedded alpha. Other new numeric
  colors are channels, not Tailwind mappings. The two existing `--opacity-*`
  metadata properties remain unchanged. Definitions/overrides must also preserve
  all inherited status/badge intrinsic-opacity metadata from the semantic palette.

Future built-in/custom-theme adapters must preserve the selection/scrollbar
sentinels when inheriting Iris, support numeric fractional channels, and retain
intrinsic-opacity metadata. Completeness alone does not establish contrast.
The strict contrast gate checks the defined critical pairs for every built-in, including
code comments. Arbitrary ANSI/terminal combinations (including terminal black),
arbitrary utility tone combinations and authored artifacts are not accessibility-certified. There are no remaining un-tokenized utility islands; see [complete coverage](../../../../docs/wiki/theme/complete-coverage.md).

## Verification

- `contentColors.test.tsx`: normalized rendered-markup parity against oneDark for
  ten languages, with/without line numbers, in both appearances, with exactly two
  owner-approved syntax ink exceptions; all ANSI rules and legacy xterm values; semantic ANSI hues; exact supporting colors; raw-color
  guard on every migrated consumer.
- `terminal.test.ts`: constructor ordering, real DOM observer updates, custom
  overrides/reset and disposal without creating a terminal session.
- Existing token completeness, opacity-substitution and initial-flash suites
  remain authoritative. No persistence or flash script change is needed: these
  colors are available synchronously in the existing resolved CSS scopes.

## Graph/canvas bridge

`tokenReader.ts` / `useThemeColors.ts` provide memoized concrete colors for
canvas/WebGL and chart consumers. Read the [graph adapter contract and contrast
matrix](../../../../docs/wiki/theme/graph-colors.md) before adding themes or custom
overrides. Graph node state aliases share semantic status tokens; chart defaults
use their own legacy palette and never rewrite authored colors. Attribute-driven
invalidation, fractional channels and intrinsic alpha apply to these consumers
as well. Quantitative library chart schemes remain library defaults.

## Custom themes and presets

The [v2 custom-theme and preset library contract](../../../../docs/wiki/theme/custom-themes.md)
documents the light/dark pair document, seed-color derivation, the owner-only
`/api/theme-presets` library, the whole-app live preview editor, device-local
recovery and the generated pre-paint bootstrap. Custom alpha uses private
split-channel helpers for opacity-modified CSS consumers; full channels and
intrinsic metadata remain the JS adapter input.

## Account synchronization

The [account sync contract](../../../../docs/wiki/theme/account-sync.md) defines device
precedence, post-paint adoption, identity boundaries and the bounded custom-document
wire format. `sync.ts` owns asynchronous reconciliation; it is not imported by the
pre-paint entrypoint. `ThemeProvider` still applies local state synchronously.
