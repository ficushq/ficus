/**
 * Theme token registry and (themeId × appearance) schema.
 *
 * Phase 0 of the color-theme architecture (research report
 * `artifacts/color-theme-investigation/report.md` §4.1–4.2, owner decisions
 * PD-4/PD-5/PD-6 in `artifacts/color-theme-investigation/decisions.md`).
 *
 * This module is the single source of truth for:
 * - the names of every themeable color token (active chrome and semantic tokens today, plus
 *   reserved name-only entries for the families later phases activate), and
 * - the theme model: a registry of themes with `kind: 'dual' | 'unified'`,
 *   resolution of (themeId, appearance) to a concrete variant, and the
 *   persistence-shape normalization used by device-local storage.
 *
 * It is deliberately platform-neutral and dependency-free: `packages/shared`
 * is imported by the browser bundle, so nothing here may touch node builtins.
 * Status *semantics* stay in `status-presentation.ts`; this file only adds the
 * color-token vocabulary used by platform adapters.
 */

// ---------------------------------------------------------------------------
// Appearance / theme-kind model (PD-6)
// ---------------------------------------------------------------------------

/**
 * A dual-variant theme provides a light and a dark token set; the appearance
 * control offers light / dark / system-auto and selects which variant
 * resolves. This is the default kind and exactly how today's light/dark look
 * is expressed.
 */
export type DualThemeKind = 'dual'

/**
 * A unified (constant) theme has a single token set; the appearance control is
 * hidden or disabled and resolution ignores the requested appearance.
 */
export type UnifiedThemeKind = 'unified'

export type ThemeKind = DualThemeKind | UnifiedThemeKind

/** What the user (or storage) requests — 'system' follows the OS preference. */
export type AppearanceSetting = 'light' | 'dark' | 'system'

/** A concrete variant after 'system' has been resolved against the OS. */
export type ResolvedAppearance = 'light' | 'dark'

/**
 * The variant actually applied. Unified themes resolve to `'constant'`: they
 * have no light/dark variant, so no appearance attribute or migration class
 * is applied for them.
 */
export type EffectiveAppearance = ResolvedAppearance | 'constant'

export const APPEARANCE_SETTINGS: readonly AppearanceSetting[] = ['light', 'dark', 'system']

export function isAppearanceSetting(value: unknown): value is AppearanceSetting {
  return typeof value === 'string' && (APPEARANCE_SETTINGS as readonly string[]).includes(value)
}

/** The built-in theme every fallback rule lands on (today's light/dark pair). */
export const DEFAULT_THEME_ID = 'tau'

/** The appearance a fresh install starts with — must match today's behavior. */
export const DEFAULT_APPEARANCE: AppearanceSetting = 'light'

// ---------------------------------------------------------------------------
// Token name registry (report §4.2)
// ---------------------------------------------------------------------------

/**
 * Whether the tokens of a family are defined by every theme today (`active`)
 * or only reserved as names for a later phase (`planned`). Activating a family
 * in a later phase flips its status here; the completeness tests then force
 * every built-in theme to define the new tokens.
 */
export type TokenFamilyStatus = 'active' | 'planned'

export interface TokenFamilyDefinition {
  /** Stable family id, e.g. 'chrome'. */
  readonly family: string
  /** What the family covers and (for planned families) which phase activates it. */
  readonly description: string
  readonly status: TokenFamilyStatus
  readonly tokens: readonly string[]
}

/**
 * The 29 chrome tokens defined per scope in `apps/web/src/index.css`
 * (`:root` light and `.dark`). Names are the CSS custom property names.
 */
const CHROME_TOKENS: readonly string[] = [
  // Backgrounds
  '--color-bg-page',
  '--color-bg-surface',
  '--color-bg-surface-secondary',
  '--color-bg-pill',
  '--color-bg-surface-hover',
  '--color-bg-inset',
  // Text
  '--color-text-primary',
  '--color-text-secondary',
  '--color-text-muted',
  '--color-text-placeholder',
  // Borders
  '--color-border',
  '--color-border-hover',
  // Inputs
  '--color-input-bg',
  '--color-input-border',
  // Shadows
  '--color-shadow',
  '--color-shadow-lg',
  // Code blocks
  '--color-code-bg',
  '--color-code-text',
  // Primary / accent
  '--color-primary',
  '--color-primary-hover',
  '--color-primary-active',
  '--color-primary-light',
  // Shared interaction surfaces
  '--color-selection-bg',
  '--color-selection-border',
  '--color-focus',
  '--color-panel-border',
  '--color-glass',
  '--color-overlay',
  // iOS PWA status bar scrim (aliases the surface)
  '--color-status-bar-scrim',
]

/** The nine platform-neutral status roles (see `status-presentation.ts`). */
export const STATUS_ROLES: readonly string[] = [
  'progress',
  'queue',
  'review',
  'human-wait',
  'external-wait',
  'attention',
  'danger',
  'success',
  'neutral',
]

/** Role × slot grid for the status token family (report §4.2). */
export const STATUS_TOKENS: readonly string[] = STATUS_ROLES.flatMap((role) => [
  `--status-${role}-fg`,
  `--status-${role}-solid`,
  `--status-${role}-surface`,
  `--status-${role}-border`,
  // Badges historically use distinct shades, retained for exact visual parity.
  `--status-${role}-badge-fg`,
  `--status-${role}-badge-surface`,
  `--status-${role}-badge-hover`,
  // Legacy app-owned controls use these tone steps; they are part of the same
  // atomic status contract, never an independently overridable raw palette.
  ...[50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950].map((step) => `--status-${role}-${step}`),
])

/** ANSI slot names shared by terminal and streamed-output palettes (values may differ). */
const ANSI_SLOTS: readonly string[] = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']

export const THEME_TOKEN_FAMILIES: readonly TokenFamilyDefinition[] = [
  {
    family: 'chrome',
    description: 'App-chrome surfaces, text, borders, inputs, shadows, primary/accent, interaction surfaces.',
    status: 'active',
    tokens: CHROME_TOKENS,
  },
  {
    family: 'status',
    description: 'One complete fg/solid/surface/border and badge-fg/surface/hover set per status role.',
    status: 'active',
    tokens: STATUS_TOKENS,
  },
  {
    family: 'agent-type',
    description: 'Agent-type identity palette, per theme variant.',
    status: 'active',
    tokens: [
      '--agent-type-1-fg',
      '--agent-type-2-fg',
      '--agent-type-3-fg',
      '--agent-type-4-fg',
      '--agent-type-5-fg',
      '--agent-type-6-fg',
    ],
  },
  {
    family: 'badge-decoration',
    description: 'Seven used decorative accent palettes, independent of status meaning (appearance compatibility).',
    status: 'active',
    tokens: Array.from({ length: 7 }, (_, i) =>
      ['fg', 'surface', 'hover'].map((slot) => `--badge-accent-${i + 1}-${slot}`)
    ).flat(),
  },
  {
    family: 'syntax',
    description: 'App-owned code-highlighting palette replacing the fixed oneDark import.',
    status: 'active',
    tokens: [
      '--syntax-bg',
      '--syntax-fg',
      '--syntax-comment',
      '--syntax-keyword',
      '--syntax-string',
      '--syntax-number',
      '--syntax-function',
      '--syntax-punctuation',
      '--syntax-operator',
      '--syntax-variable',
      '--syntax-property',
      '--syntax-url',
      '--syntax-shadow',
      '--syntax-memory-bg',
      '--syntax-image-bg',
      '--syntax-error-fg',
      '--syntax-human-link',
      '--syntax-human-code-fg',
      '--syntax-human-code-bg',
    ],
  },
  {
    family: 'terminal',
    description: 'xterm ITheme surface (background/foreground/cursor/selection/scrollbar + 16 ANSI slots).',
    status: 'active',
    tokens: [
      '--term-bg',
      '--term-fg',
      '--term-cursor',
      '--term-cursor-accent',
      '--term-selection-background',
      // `none` preserves each selected cell's ANSI ink; otherwise RGB channels.
      '--term-selection-foreground',
      // `auto` preserves native scrollbars; otherwise themes supply RGB channels.
      '--term-scrollbar-thumb',
      '--term-scrollbar-thumb-hover',
      '--term-scrollbar-thumb-active',
      '--term-loading-bg',
      '--term-muted',
      ...ANSI_SLOTS.map((slot) => `--term-${slot}`),
      ...ANSI_SLOTS.map((slot) => `--term-bright-${slot}`),
    ],
  },
  {
    family: 'ansi',
    description: 'Streamed ANSI foreground/background slots and their contrasting text colors.',
    status: 'active',
    tokens: [
      ...ANSI_SLOTS.map((slot) => `--ansi-${slot}`),
      ...ANSI_SLOTS.map((slot) => `--ansi-bright-${slot}`),
      ...ANSI_SLOTS.map((slot) => `--ansi-bg-${slot}`),
      ...ANSI_SLOTS.map((slot) => `--ansi-bg-bright-${slot}`),
      ...ANSI_SLOTS.map((slot) => `--ansi-on-${slot}`),
      '--ansi-on-bright-white',
    ],
  },
  {
    family: 'graph',
    description: 'Canvas/force-graph palette and content-safe chart defaults, read through the live token bridge.',
    status: 'active',
    tokens: [
      '--graph-bg',
      '--graph-label',
      '--graph-label-muted',
      '--graph-node-border',
      '--graph-node-selected-3d',
      '--graph-loading-bg',
      '--graph-legend-idle',
      '--graph-legend-paused',
      // Chart defaults retain Vega's existing palette, independently of the dark graph scenes.
      '--graph-chart-bg',
      '--graph-chart-fg',
      '--graph-chart-mark',
      '--graph-chart-axis',
      '--graph-chart-grid',
      ...Array.from({ length: 10 }, (_, i) => `--graph-chart-category-${i + 1}`),
      '--graph-node-selected',
      '--graph-node-active',
      '--graph-node-paused',
      '--graph-node-archived',
      '--graph-link-1',
      '--graph-link-2',
      '--graph-link-3',
      '--graph-link-4',
      '--graph-link-5',
      '--graph-link-6',
    ],
  },
  {
    family: 'misc-chrome',
    description: 'Scrollbar thumb, text on accent fills, checkbox check glyph.',
    status: 'active',
    tokens: ['--scrollbar-thumb', '--on-accent-fg', '--checkbox-check'],
  },
  {
    family: 'utility-decoration',
    description: 'Retained non-lifecycle decorative tone steps; no unused palette entries.',
    status: 'active',
    tokens: [
      '--decoration-8-100',
      '--decoration-8-300',
      '--decoration-8-400',
      '--decoration-8-600',
      '--decoration-8-700',
      '--decoration-8-900',
      '--decoration-9-100',
      '--decoration-9-400',
      '--decoration-9-600',
      '--decoration-9-900',
      '--decoration-10-200',
      '--decoration-11-50',
      '--decoration-11-100',
      '--decoration-11-300',
      '--decoration-11-500',
      '--decoration-11-600',
      '--decoration-11-700',
      '--decoration-11-900',
      '--decoration-4-50',
      '--decoration-4-300',
      '--decoration-4-500',
      '--decoration-4-600',
    ],
  },
  {
    family: 'utility-chrome',
    description: 'Paper surfaces, scrims, highlights, filled-control ink and switch thumbs.',
    status: 'active',
    tokens: ['--chrome-paper', '--chrome-scrim', '--chrome-highlight', '--on-strong', '--chrome-toggle-thumb'],
  },
  {
    family: 'voice-material',
    description: 'Voice state glows, glass lighting, shadows and status indicators.',
    status: 'active',
    tokens: [
      '--voice-page-glow-cool',
      '--voice-page-glow-warm',
      '--voice-shadow',
      '--voice-idle-primary',
      '--voice-idle-secondary',
      '--voice-idle-tertiary',
      '--voice-listening-primary',
      '--voice-listening-secondary',
      '--voice-listening-highlight',
      '--voice-speaking-depth',
      '--voice-muted-primary',
      '--voice-muted-secondary',
      '--voice-muted-depth',
      '--voice-processing-highlight',
      '--voice-warning-primary',
      '--voice-warning-secondary',
      '--voice-warning-tertiary',
      '--voice-glass-highlight',
      '--voice-glass-frost',
      '--voice-glass-reflection',
      '--voice-glass-shade',
      '--voice-glass-depth',
      '--voice-glass-shadow',
      '--voice-swirl-cool',
      '--voice-swirl-cool-depth',
      '--voice-swirl-warm',
      '--voice-swirl-warm-depth',
      '--voice-rim-depth',
      '--voice-live-shadow',
      '--voice-live-ring',
      '--voice-listening-depth',
      '--voice-listening-bright',
      '--voice-muted-shadow',
      '--voice-processing-depth',
      '--voice-warning-depth',
      '--voice-warning-highlight',
      '--voice-status-ring',
    ],
  },
  {
    family: 'log-terminal',
    description: 'Read-only logs retain their original xterm palette, independently themeable.',
    status: 'active',
    tokens: [
      '--log-black',
      '--log-red',
      '--log-green',
      '--log-yellow',
      '--log-blue',
      '--log-magenta',
      '--log-cyan',
      '--log-white',
      '--log-bright-black',
      '--log-bright-red',
      '--log-bright-green',
      '--log-bright-yellow',
      '--log-bright-blue',
      '--log-bright-magenta',
      '--log-bright-cyan',
      '--log-bright-white',
      '--log-bg',
      '--log-fg',
      '--log-cursor',
      '--log-cursor-accent',
      '--log-selection-background',
      '--log-selection-foreground',
    ],
  },
  {
    family: 'brand',
    description: 'Themeable logo gradient, underlying tile, and glyph ink (PD-5).',
    status: 'active',
    tokens: ['--brand-gradient-from', '--brand-gradient-to', '--brand-tile', '--brand-ink'],
  },
  {
    family: 'swatch',
    description: "The theme's secondary and tertiary identity colors, blended with its primary in theme swatches.",
    status: 'active',
    tokens: ['--swatch-secondary', '--swatch-tertiary'],
  },
]

/** Every token a theme must define today (all `active` families). */
export const ACTIVE_THEME_TOKENS: readonly string[] = THEME_TOKEN_FAMILIES.filter((f) => f.status === 'active').flatMap(
  (f) => f.tokens
)

/** Reserved names for later phases (all `planned` families). */
export const PLANNED_THEME_TOKENS: readonly string[] = THEME_TOKEN_FAMILIES.filter(
  (f) => f.status === 'planned'
).flatMap((f) => f.tokens)

/** The complete registry: active + planned, the closed vocabulary of theme tokens. */
export const THEME_TOKEN_NAMES: readonly string[] = [...ACTIVE_THEME_TOKENS, ...PLANNED_THEME_TOKENS]

export function isThemeTokenName(name: string): boolean {
  return (THEME_TOKEN_NAMES as readonly string[]).includes(name)
}

export function themeTokenFamily(name: string): TokenFamilyDefinition | undefined {
  return THEME_TOKEN_FAMILIES.find((f) => (f.tokens as readonly string[]).includes(name))
}

// ---------------------------------------------------------------------------
// Token-set completeness schema
// ---------------------------------------------------------------------------

export interface TokenSetValidation {
  ok: boolean
  /** Required registry tokens the set does not define. */
  readonly missing: readonly string[]
  /** Tokens outside the required registry set (including not-yet-active planned names). */
  readonly unexpected: readonly string[]
}

/**
 * Validates that a concrete token set defines *exactly* the registry's active
 * token names — the completeness invariant every built-in theme must hold.
 * When a family is activated in a later phase its names move into the required
 * set automatically and this validation starts failing for themes that have
 * not been updated, which is exactly the guard we want.
 */
export function validateThemeTokenSet(defined: Iterable<string>): TokenSetValidation {
  const required = new Set(ACTIVE_THEME_TOKENS)
  const definedSet = new Set(defined)
  const missing = [...required].filter((name) => !definedSet.has(name))
  const unexpected = [...definedSet].filter((name) => !required.has(name))
  return { ok: missing.length === 0 && unexpected.length === 0, missing, unexpected }
}

/**
 * Partial custom overrides may inherit other families, but status is atomic:
 * touching any role requires the entire role/slot grid, including badge shades.
 * This is a name/completeness check; color-value validation belongs to the importer.
 */
export function validateThemeTokenOverrides(defined: Iterable<string>): TokenSetValidation {
  const names = new Set(defined)
  const active = new Set(ACTIVE_THEME_TOKENS)
  const missing = STATUS_TOKENS.some((name) => names.has(name)) ? STATUS_TOKENS.filter((name) => !names.has(name)) : []
  const unexpected = [...names].filter((name) => !active.has(name))
  return { ok: missing.length === 0 && unexpected.length === 0, missing, unexpected }
}

// ---------------------------------------------------------------------------
// Theme registry model + resolution (report §4.1)
// ---------------------------------------------------------------------------

/** A theme as registered by a platform adapter (web today). */
export interface ThemeDescriptor {
  readonly id: string
  readonly label: string
  readonly kind: ThemeKind
}

export interface ThemeRegistryIssue {
  readonly themeId: string
  readonly issue: string
}

/**
 * Structural validation for a theme registry: unique ids, non-empty labels,
 * valid kinds, and exactly one default entry (the `DEFAULT_THEME_ID`, falling
 * back to the first entry only when the default id is absent).
 */
export function validateThemeRegistry(registry: readonly ThemeDescriptor[]): readonly ThemeRegistryIssue[] {
  const issues: ThemeRegistryIssue[] = []
  const seen = new Set<string>()
  for (const theme of registry) {
    if (seen.has(theme.id)) issues.push({ themeId: theme.id, issue: 'duplicate id' })
    seen.add(theme.id)
    if (!/^[a-z0-9][a-z0-9-]*$/.test(theme.id)) issues.push({ themeId: theme.id, issue: 'id must be kebab-case' })
    if (typeof theme.label !== 'string' || theme.label.length === 0)
      issues.push({ themeId: theme.id, issue: 'label must be a non-empty string' })
    if (theme.kind !== 'dual' && theme.kind !== 'unified')
      issues.push({ themeId: theme.id, issue: `invalid kind ${String(theme.kind)}` })
  }
  if (registry.length === 0) issues.push({ themeId: '', issue: 'registry is empty' })
  return issues
}

export interface ResolvedThemeSelection<Theme extends ThemeDescriptor = ThemeDescriptor> {
  /** The registered theme that wins (never a synthesized entry). */
  readonly theme: Theme
  /** 'constant' for unified themes; otherwise the concrete light/dark variant. */
  readonly appearance: EffectiveAppearance
}

/**
 * Resolves (themeId, appearance) to a registered theme + concrete variant with
 * the fallback rules from report §4.1:
 *
 * - unknown or missing themeId → the default theme (never an error, never an
 *   invented palette);
 * - a unified theme ignores the requested appearance entirely and resolves to
 *   `'constant'`;
 * - `appearance: 'system'` resolves against `systemPrefersDark`;
 * - missing/invalid appearance → `DEFAULT_APPEARANCE`.
 *
 * Resolution only ever *selects*; it never derives colors (no hue math).
 */
export function resolveThemeSelection<Theme extends ThemeDescriptor>(
  registry: readonly Theme[],
  requestedThemeId: string | null | undefined,
  requestedAppearance: AppearanceSetting | null | undefined,
  systemPrefersDark: boolean
): ResolvedThemeSelection<Theme> {
  const defaultTheme = registry.find((theme) => theme.id === DEFAULT_THEME_ID) ?? registry[0]
  const theme =
    (requestedThemeId != null ? registry.find((entry) => entry.id === requestedThemeId) : undefined) ??
    defaultTheme ??
    (() => {
      throw new Error('resolveThemeSelection requires a non-empty theme registry')
    })()
  if (theme.kind === 'unified') return { theme, appearance: 'constant' }
  const appearance = requestedAppearance ?? DEFAULT_APPEARANCE
  const resolved: ResolvedAppearance = appearance === 'system' ? (systemPrefersDark ? 'dark' : 'light') : appearance
  return { theme, appearance: resolved }
}

// ---------------------------------------------------------------------------
// Stored-selection normalization (persistence seam, PD-2)
// ---------------------------------------------------------------------------

/** The device-local selection shape: new keys `ficus-theme-id` + `ficus-appearance`. */
export interface StoredThemeSelection {
  readonly themeId: string
  readonly appearance: AppearanceSetting
}

export interface StoredThemeSelectionInput {
  /** Value of `ficus-theme-id` (new key), if any. */
  readonly themeId: string | null | undefined
  /** Value of `ficus-appearance` (new key), if any. */
  readonly appearance: string | null | undefined
  /** Value of the legacy `ficus-theme` key ('light' | 'dark'), if any. */
  readonly legacyTheme: string | null | undefined
  /** Registry ids considered known; defaults to just the default theme. */
  readonly knownThemeIds?: readonly string[]
  /** Appearance when nothing is stored; defaults to DEFAULT_APPEARANCE. */
  readonly defaultAppearance?: AppearanceSetting
}

/**
 * Normalizes raw stored strings into a valid selection, migrating the legacy
 * `ficus-theme` value ('light' | 'dark') into the (themeId, appearance) model.
 * Unreadable, missing, or unknown values fall back to the defaults
 * (DEFAULT_THEME_ID, DEFAULT_APPEARANCE) — never an error at read time. This
 * stays a pure function so the pre-paint flash script, the provider, and a
 * future async account-sync layer can share one rule set.
 */
export function normalizeStoredThemeSelection(input: StoredThemeSelectionInput): StoredThemeSelection {
  const known = input.knownThemeIds ?? [DEFAULT_THEME_ID]
  const themeId =
    input.themeId != null && (known as readonly string[]).includes(input.themeId) ? input.themeId : DEFAULT_THEME_ID
  const appearance = isAppearanceSetting(input.appearance)
    ? input.appearance
    : input.legacyTheme === 'light' || input.legacyTheme === 'dark'
      ? input.legacyTheme
      : (input.defaultAppearance ?? DEFAULT_APPEARANCE)
  return { themeId, appearance }
}

// ---------------------------------------------------------------------------
// Closed color grammar (shared by custom-theme.ts and theme-derivation.ts;
// lives here, the module both depend on, to avoid a circular import between them)
// ---------------------------------------------------------------------------

/** Closed color grammar: integer RGB channels, optional unit-interval alpha.
 * No CSS parser, URLs, references, percentages, exponents or arbitrary functions.
 * Internal built-in channels/sentinels are inherited, never imported as values. */
export function customColorChannels(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const color = value.trim()
  const hex = /^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.exec(color)
  if (hex) {
    const digits = color.slice(1)
    const expanded = digits.length === 3 ? [...digits].map((d) => d + d).join('') : digits
    const parts = expanded.match(/../g)!.map((d) => parseInt(d, 16))
    return parts.slice(0, 3).join(' ') + (parts.length === 4 ? ` / ${parts[3]! / 255}` : '')
  }
  const match = /^(rgb|rgba)\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(0|1|0?\.\d+|1\.0+))?\s*\)$/.exec(
    color
  )
  if (!match || (match[1] === 'rgba') !== (match[5] !== undefined)) return null
  const rgb = match.slice(2, 5).map(Number)
  if (rgb.some((n) => n > 255)) return null
  return rgb.join(' ') + (match[5] === undefined ? '' : ` / ${Number(match[5])}`)
}
