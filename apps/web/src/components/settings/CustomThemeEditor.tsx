import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ACTIVE_THEME_TOKENS,
  STATUS_TOKENS,
  assistantEditorInstructionsByKind,
  assistantEditorToolDefinitionsByKind,
  CUSTOM_THEME_FORMAT,
  customColorChannels,
  reshapeCustomThemeForBase,
  validateCustomTheme,
  withCustomThemeVariant,
  type AssistantEditorProposal,
  type AssistantEditorSync,
  type CustomThemeDocument,
  type ThemeInsightsVariant,
  type ThemePalette,
  type ThemePreset,
} from '@ficus/shared'
import { isHttpResponseError } from '@ficus/client-core'
import { suggestPaletteSeeds } from '@ficus/shared/theme-derivation'
import type { useTheme } from '../../providers/ThemeProvider'
import { useThemePreview } from '../../providers/ThemeProvider'
import { usePermissions } from '../../hooks/usePermissions'
import { BUILT_IN_THEMES, findWebTheme } from '../../theme/registry'
import { exportCustomTheme, readPreviewTokens, removeCustomProperties } from '../../theme/custom'
import { applyResolvedTheme } from '../../theme/apply'
import { paintRoot } from '../../theme/preview'
import { contrast, contrastPairs, pairBackground, tokenRgba, type ContrastPair } from '../../theme/contrast'
import { computeThemeInsights } from '../../theme/insights'
import { client } from '../../api/clientInstance'
import { themePresetQueryKeys } from '../../queryKeys'
import { useStableRef } from '../../hooks/useStableRef'
import { PageEditorAssistant } from '../PageEditorAssistant'
import { UndoIcon, RedoIcon, CloseIcon } from '../icons'
import { SegmentedControl, type SegmentedControlOption } from '../SegmentedControl'

interface Warning {
  pair: ContrastPair
  ratio: number | null
  safe: string | null
}

const CONTRAST_OPTIONS: readonly SegmentedControlOption<'standard' | 'high'>[] = [
  { value: 'standard', label: 'Standard' },
  { value: 'high', label: 'High' },
]
const STATUS_MODE_OPTIONS: readonly SegmentedControlOption<'static' | 'harmonized'>[] = [
  { value: 'static', label: 'Static' },
  { value: 'harmonized', label: 'Harmonized' },
]

/** A variant tab is always a concrete side, never 'system' (the editor edits
 * concrete light/dark overrides; the app's Light/Dark/System toggle resolves
 * which one paints later). */
type VariantTab = 'light' | 'dark' | 'constant'

const EDITING_VARIANT_OPTIONS: readonly SegmentedControlOption<'light' | 'dark'>[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

function emptyThemeDocument(baseId: string): CustomThemeDocument {
  const base = findWebTheme(baseId)
  return {
    format: CUSTOM_THEME_FORMAT,
    version: 2,
    name: 'New theme',
    base: base.id,
    variants: base.kind === 'unified' ? { constant: {} } : { light: {}, dark: {} },
  }
}

function variantOverrides(doc: CustomThemeDocument, tab: VariantTab): Record<string, string> {
  return 'constant' in doc.variants ? doc.variants.constant : doc.variants[tab === 'dark' ? 'dark' : 'light']
}

function withVariantOverrides(
  doc: CustomThemeDocument,
  tab: VariantTab,
  overrides: Record<string, string>
): CustomThemeDocument {
  return { ...doc, variants: withCustomThemeVariant(doc.variants, tab, overrides) }
}

/** Reshapes variants across a base-kind change: unified -> dual seeds both
 * sides with the same starting overrides; dual -> unified merges both sides
 * (dark taking precedence on conflicting tokens is an arbitrary but stable
 * choice — the user reviews the result immediately in the live preview). */
function reshapeForBase(doc: CustomThemeDocument, nextBaseId: string): CustomThemeDocument {
  return reshapeCustomThemeForBase(doc, findWebTheme(nextBaseId))
}

// "r g b" (or "r g b / a", alpha ignored) compiled-form channels -> #rrggbb,
// for the native <input type="color"> swatch (which only accepts that strict
// form). Shared by both the real-value and "not set yet" placeholder paths
// below so neither needs its own literal.
function channelsToSwatchHex(channels: string): string {
  const [rgb] = channels.split(' / ')
  const [r, g, b] = rgb!.trim().split(/\s+/).map(Number)
  const hex = (n: number) =>
    Math.round(Number.isFinite(n) ? n : 0)
      .toString(16)
      .padStart(2, '0')
  return `#${hex(r!)}${hex(g!)}${hex(b!)}`
}

/** Native `<input type="color">` only accepts a strict #rrggbb value. Any
 * validly-formed accepted color (hex or rgb()/rgba()) resolves to its own
 * hex for the swatch preview; alpha is dropped there (the closed grammar and
 * alpha stay text-only, in the paired text field). Empty/invalid input falls
 * back to the ACTIVE base theme's own `--color-border` token (read live off
 * `document.documentElement`'s cascade, never a hardcoded literal — this file
 * already carries an explicit, capped no-raw-colors allowlist entry for its
 * genuine theme-authoring/contrast-math literals; this placeholder isn't one
 * of those, so it doesn't get a color of its own at all) rather than leaving
 * the widget without a value (the browser control requires one). */
function toSwatchHex(value: string): string {
  const channels = customColorChannels(value)
  if (channels) return channelsToSwatchHex(channels)
  const root = document.documentElement
  const border = root.ownerDocument.defaultView!.getComputedStyle(root).getPropertyValue('--color-border').trim()
  return channelsToSwatchHex(border || '0 0 0')
}

/** A seed-color field: a native color-picker swatch alongside the hex/rgb()/
 * rgba() text field (the source of truth — the closed grammar and alpha stay
 * text-only), with an optional Clear action for unset-able (non-Primary) seeds.
 *
 * The swatch and the text field commit differently for undo coalescing
 * purposes: a swatch pick is a discrete, non-typing action (its own undo
 * step, via `onSwatchChange`), while the text field is typed and coalesces
 * with adjacent edits to the same field (via `onChange` + `onBlur` ending the
 * session early). `onSwatchChange` defaults to `onChange` for callers that
 * don't need the distinction. */
function ColorField({
  label,
  value,
  onChange,
  onSwatchChange,
  onClear,
  onBlur,
}: {
  label: string
  value: string
  onChange: (next: string) => void
  onSwatchChange?: (next: string) => void
  onClear?: () => void
  onBlur?: () => void
}) {
  // Explicit htmlFor/id (text field) + explicit aria-label (color swatch) —
  // deliberately not one <label> wrapping both controls, which would give
  // them the same ambiguous accessible name.
  const id = useId()
  const clearable = !!onClear && !!value
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id}>{label}</label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={`${label} color swatch`}
          value={toSwatchHex(value)}
          onChange={(event) => (onSwatchChange ?? onChange)(event.target.value)}
          className="ficus-color-input h-9 w-9 shrink-0 cursor-pointer rounded-md"
        />
        <div className="relative min-w-0 flex-1">
          <input
            id={id}
            type="text"
            className={clsx('ficus-field w-full px-3 py-2', clearable && 'pr-8')}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onBlur={onBlur}
            placeholder={onClear ? 'Not set' : 'Hex, rgb() or rgba()'}
          />
          {clearable && (
            <button
              type="button"
              aria-label={`Clear ${label}`}
              onClick={onClear}
              className="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-muted hover:bg-surface-hover hover:text-primary"
            >
              <CloseIcon className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/** A compiled "r g b" token value as a hex color, or undefined when there is none. */
function channelsToHex(channels: string | undefined): string | undefined {
  const parts = channels?.trim().split(/\s+/).slice(0, 3).map(Number)
  if (!parts || parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return undefined
  return `#${parts.map((n) => Math.round(n).toString(16).padStart(2, '0')).join('')}`
}

export function CustomThemeEditor({
  value,
  preset,
  baseId,
  onClose,
  assistantDependencies,
  focusAssistant,
  idleCoalesceMs,
  scheduleIdleTimeout,
  cancelIdleTimeout,
}: {
  value: ReturnType<typeof useTheme>
  /** The library preset being edited, or null when authoring a brand-new one. */
  preset: ThemePreset | null
  /** Initial base theme for a new preset; ignored once `preset` is set. */
  baseId: string
  onClose: () => void
  assistantDependencies?: Parameters<typeof PageEditorAssistant>[0]['conversationDependencies']
  /** "New theme" (the library's single new-preset action): move DOM focus to
   * the assistant panel on mount. A no-op when the panel isn't rendered
   * (`can('chat:send')` false), so "New theme" behaves identically with or
   * without the assistant. `Edit` never passes this, so opening an existing
   * preset never steals focus away from the fields. */
  focusAssistant?: boolean
  /** How long a typed-field undo session stays open with no further keystroke
   * before the next keystroke opens a new step. Defaults to 800ms. */
  idleCoalesceMs?: number
  /** Injected scheduler for the idle-coalescing timer (mirrors
   * createInvalidationCoalescer's injectable clock) — defaults to real timers. */
  scheduleIdleTimeout?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
  cancelIdleTimeout?: (handle: ReturnType<typeof setTimeout>) => void
}) {
  const { setPreview } = useThemePreview()
  const cache = useQueryClient()
  const { can } = usePermissions()
  const [draft, setDraft] = useState<CustomThemeDocument>(() => preset?.document ?? emptyThemeDocument(baseId))
  const base = findWebTheme(draft.base)
  const baseHintId = useId()
  const [tab, setTab] = useState<VariantTab>(base.kind === 'unified' ? 'constant' : value.theme)
  const [token, setToken] = useState(ACTIVE_THEME_TOKENS[0]!)
  const [color, setColor] = useState('#336699')
  const [notice, setNotice] = useState('')
  const [warnings, setWarnings] = useState<Warning[]>([])
  const [previewError, setPreviewError] = useState('')
  const baseTokens = useRef<Record<string, string>>({})
  const validation = validateCustomTheme(JSON.stringify(draft), BUILT_IN_THEMES)
  const overrides = variantOverrides(draft, tab)
  const valueRef = useStableRef(value)
  const palette = draft.palette

  // Shared undo/redo (assistant edits and manual edits, like WorkflowEditor):
  // `revision` and the past/future stacks back the assistant draft envelope
  // below. `commitDraft`/`commitTypedDraft` are the two paths manual handlers
  // use to change the document so every change is undoable the same way.
  const [revision, setRevision] = useState(0)
  const [past, setPast] = useState<CustomThemeDocument[]>([])
  const [future, setFuture] = useState<CustomThemeDocument[]>([])

  const idleMs = idleCoalesceMs ?? 800
  const scheduleTimeout = scheduleIdleTimeout ?? ((callback: () => void, ms: number) => setTimeout(callback, ms))
  const cancelTimeout = cancelIdleTimeout ?? ((handle: ReturnType<typeof setTimeout>) => clearTimeout(handle))
  // An in-progress typed-field coalescing session: consecutive keystrokes in
  // the SAME field collapse into the one undo step opened when the session
  // started, until the field changes, the input blurs, the idle timer fires,
  // or a non-typing commit (commitDraft) closes it first.
  const typingSession = useRef<{ field: string; timer: ReturnType<typeof setTimeout> } | null>(null)
  const closeTypingSession = () => {
    if (typingSession.current) cancelTimeout(typingSession.current.timer)
    typingSession.current = null
  }
  // Cancels a stray idle timer if the editor unmounts mid-session. Runs its
  // cleanup only on unmount — `closeTypingSession` is intentionally excluded
  // (it's a fresh closure every render, same as the `focusAssistant` effect
  // below).
  useEffect(() => closeTypingSession, []) // eslint-disable-line react-hooks/exhaustive-deps

  /** The one path every NON-typing draft change uses (color-picker swatches,
   * toggles, the base-theme select, per-token Preview/Remove/safe-value
   * buttons): always its own undo step, and closes any in-progress typed
   * session first so a later keystroke in the same field starts fresh rather
   * than merging across the boundary. */
  const commitDraft = (next: CustomThemeDocument) => {
    closeTypingSession()
    if (JSON.stringify(next) === JSON.stringify(draft)) return
    setPast((items) => [...items.slice(-49), draft])
    setFuture([])
    setDraft(next)
    setRevision((r) => r + 1)
  }

  /** Typed-field edits (theme name, palette hex/rgb text fields): consecutive
   * edits to the SAME field coalesce into the one undo step opened when that
   * field's session started. The revision still bumps on every keystroke —
   * only the undo-history granularity changes. */
  const commitTypedDraft = (field: string, next: CustomThemeDocument) => {
    if (JSON.stringify(next) === JSON.stringify(draft)) return
    const session = typingSession.current
    if (session) cancelTimeout(session.timer)
    if (!session || session.field !== field) {
      setPast((items) => [...items.slice(-49), draft])
      setFuture([])
    }
    setDraft(next)
    setRevision((r) => r + 1)
    typingSession.current = {
      field,
      timer: scheduleTimeout(() => {
        typingSession.current = null
      }, idleMs),
    }
  }
  const [insights, setInsights] = useState<Partial<Record<VariantTab, ThemeInsightsVariant>>>({})
  const assistantPanel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (focusAssistant) assistantPanel.current?.focus()
    // Only ever run once, on mount — this is a one-shot "open focused", not a re-focus on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Setting a primary color starts derivation; clearing it removes the whole
   * palette (a preset created from a built-in with no palette is pure explicit
   * overrides, exactly like before). A new primary also fills Secondary and
   * Tertiary with its colour-theory companions while they are blank or still
   * the previous primary's companions, so they follow Primary until edited.
   * Pure — callers choose whether the resulting document commits as a typed
   * (coalesced) or immediate step. */
  const paletteDraft = (patch: Partial<ThemePalette> | null): CustomThemeDocument => {
    if (patch === null) {
      const { palette: _drop, ...rest } = draft
      return rest
    }
    const next: ThemePalette = { primary: palette?.primary ?? '', ...palette, ...patch }
    // Another seed set before Primary starts from the base theme's own primary, so the palette is valid at once.
    if (!next.primary) next.primary = channelsToHex(baseTokens.current['--color-primary']) ?? ''
    const newPrimary = patch.primary ?? (palette?.primary ? undefined : next.primary)
    const companions = newPrimary ? suggestPaletteSeeds(newPrimary) : null
    if (companions) {
      const previous = palette?.primary ? suggestPaletteSeeds(palette.primary) : null
      for (const seed of ['secondary', 'tertiary'] as const)
        if (!(seed in patch) && (!palette?.[seed] || palette[seed] === previous?.[seed])) next[seed] = companions[seed]
    }
    return { ...draft, palette: next }
  }
  /** A palette hex/rgb TEXT field's onChange: coalesces with other edits to
   * the same seed while the user keeps typing. */
  const setPaletteTyped = (field: string, patch: Partial<ThemePalette> | null) =>
    commitTypedDraft(`palette.${field}`, paletteDraft(patch))
  /** A palette seed's color-picker swatch or Clear button: always its own
   * step, per the coalescing spec's "non-typing action" list. */
  const setPaletteImmediate = (patch: Partial<ThemePalette> | null) => commitDraft(paletteDraft(patch))

  // Assistant draft envelope + shared undo/redo delivery, mirroring
  // WorkflowBuilder's applyAssistantEdit: a stable ref holds the latest state
  // so two edits arriving before React commits the first still see each
  // other (never a stale revision), and manual edits share the same
  // past/future stacks as assistant edits.
  const current = useStableRef({ draft, revision, past, future, insights, tab, preset })
  const applyAssistantEdit = (proposal: AssistantEditorProposal): AssistantEditorSync | undefined => {
    // An assistant proposal (or an Undo/Redo click, which also routes through
    // here) is always its own step — never merged with an in-progress typed
    // session, so a keystroke resumed afterward starts fresh.
    closeTypingSession()
    const latest = current.current
    const target = latest.preset ? { presetId: latest.preset.id } : {}
    if (proposal.historyAction) {
      if (proposal.baseRevision !== latest.revision) {
        setNotice('The draft changed. Ask the assistant to read it before undoing or redoing.')
        return undefined
      }
      const stack = proposal.historyAction === 'redo' ? latest.future : latest.past
      const saved = stack.at(-1)
      if (!saved) {
        setNotice(`Nothing to ${proposal.historyAction}.`)
        return undefined
      }
      const nextPast = proposal.historyAction === 'redo' ? [...latest.past, latest.draft] : stack.slice(0, -1)
      const nextFuture = proposal.historyAction === 'redo' ? stack.slice(0, -1) : [...latest.future, latest.draft]
      setPast(nextPast)
      setFuture(nextFuture)
      setDraft(saved)
      const nextRevision = latest.revision + 1
      setRevision(nextRevision)
      setNotice('')
      current.current = { ...latest, draft: saved, revision: nextRevision, past: nextPast, future: nextFuture }
      return {
        kind: 'theme',
        target,
        revision: nextRevision,
        document: saved,
        selection: { tab: latest.tab },
        history: { canUndo: nextPast.length > 0, canRedo: nextFuture.length > 0 },
        insights: latest.insights,
      }
    }
    const validation = validateCustomTheme(JSON.stringify(proposal.document), BUILT_IN_THEMES)
    if (proposal.baseRevision !== latest.revision || !validation.ok) {
      setNotice(
        !validation.ok
          ? "The assistant's edit was invalid. Ask it to repair the theme."
          : 'The draft changed before this edit arrived. Ask the assistant to retry using the latest version.'
      )
      return undefined
    }
    setNotice('')
    const unchanged = JSON.stringify(validation.document) === JSON.stringify(latest.draft)
    const nextRevision = latest.revision + (unchanged ? 0 : 1)
    const nextPast = unchanged ? latest.past : [...latest.past.slice(-49), latest.draft]
    const nextFuture = unchanged ? latest.future : []
    if (!unchanged) {
      setPast(nextPast)
      setFuture(nextFuture)
      setDraft(validation.document)
      setRevision(nextRevision)
    }
    current.current = {
      ...latest,
      draft: validation.document,
      revision: nextRevision,
      past: nextPast,
      future: nextFuture,
    }
    return {
      kind: 'theme',
      target,
      revision: nextRevision,
      document: validation.document,
      selection: { tab: latest.tab },
      history: unchanged
        ? { canUndo: latest.past.length > 0, canRedo: latest.future.length > 0 }
        : { canUndo: true, canRedo: false },
      insights: latest.insights,
    }
  }
  const editorDraft = useMemo<AssistantEditorSync>(
    () => ({
      kind: 'theme',
      target: preset ? { presetId: preset.id } : {},
      revision,
      document: draft,
      selection: { tab },
      history: { canUndo: past.length > 0, canRedo: future.length > 0 },
      insights,
    }),
    [preset, revision, draft, tab, past.length, future.length, insights]
  )

  // Whole-app live preview while the editor is open: paints the draft's
  // CURRENT tab onto document.documentElement itself (pure DOM, the same
  // paintRoot path ThemeQuickPicker's hover preview uses) — no persistence
  // until Save. Registered through ThemeProvider's preview slot (not a direct
  // paintRoot call): the provider reapplies this painter after every one of
  // its OWN real paints, so this preview survives a quick-picker appearance
  // change, a storage event from another tab, or remote account-sync
  // adoption happening while the editor is open, instead of being silently
  // clobbered by it. Runs on every draft/tab change; the effect's cleanup
  // (unmount, or superseded by a later registrant) restores the saved
  // selection via the SAME slot — see useThemePreview's doc comment.
  useLayoutEffect(() => {
    const paint = () => {
      const root = document.documentElement
      removeCustomProperties(root)
      applyResolvedTheme(root, base, tab)
      baseTokens.current = readPreviewTokens(root)
      setPreviewError('')
      setWarnings([])
      if (!validation.ok) return
      try {
        paintRoot(root, base, tab, validation.document)
      } catch {
        removeCustomProperties(root)
        setPreviewError('Preview could not be applied. The page theme has not changed.')
        return
      }
      try {
        const tokens = readPreviewTokens(root)
        const next: Warning[] = []
        for (const pair of contrastPairs) {
          // No CSS in SSR/test renderers: a missing value isn't a contrast claim.
          if (!tokens[pair.fg] || !tokens[pair.bg]) continue
          const bg = pairBackground(tokens, pair)
          if (!bg) {
            next.push({ pair, ratio: null, safe: null })
            continue
          }
          const ratio = contrast(tokenRgba(tokens, pair.fg), bg)
          if (ratio >= pair.minimum) continue
          next.push({
            pair,
            ratio,
            safe: contrast([0, 0, 0], bg) >= contrast([255, 255, 255], bg) ? '#000000' : '#ffffff',
          })
        }
        setWarnings(next)
        // Model-facing insights for whichever variant just painted (see
        // theme-assistant.ts): accumulates across tabs as the user/assistant
        // visits each side, reusing this same pass's warnings (no second loop).
        setInsights((prev) => ({ ...prev, [tab]: computeThemeInsights(tokens, tab, next) }))
      } catch {
        setNotice('Contrast analysis is unavailable for this preview; Apply is still available.')
      }
    }
    return setPreview(paint)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, tab, setPreview])

  const override = (name: string, nextColor: string) => {
    const next = { ...overrides }
    if (STATUS_TOKENS.includes(name) && !STATUS_TOKENS.every((key) => key in next)) {
      // The editor helps author the atomic status grid; importer never fills it
      // silently before validation. Built-in status RGB channels are integers.
      try {
        for (const key of STATUS_TOKENS) {
          const parts = baseTokens.current[key]!.split('/').map((part) => part.trim())
          const rgb = parts[0]!.split(/\s+/).map(Number).map(Math.round).join(', ')
          next[key] = parts[1] ? `rgba(${rgb}, ${Number(parts[1])})` : `rgb(${rgb})`
        }
      } catch {
        setNotice('Status base values are not available. Try reopening the editor.')
        return
      }
    }
    next[name] = nextColor
    commitDraft(withVariantOverrides(draft, tab, next))
  }
  const removeOverride = (name: string) => {
    const next = { ...overrides }
    for (const key of STATUS_TOKENS.includes(name) ? STATUS_TOKENS : [name]) delete next[key]
    commitDraft(withVariantOverrides(draft, tab, next))
  }
  const download = () => {
    try {
      const url = URL.createObjectURL(new Blob([exportCustomTheme(draft)], { type: 'application/json' }))
      const link = document.createElement('a')
      link.href = url
      link.download = `${CUSTOM_THEME_FORMAT}.json`
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 0)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Export failed.')
    }
  }

  const create = useMutation({
    mutationFn: (document: CustomThemeDocument) => client.themePresets.create(document),
    onSuccess: (created) => {
      void cache.invalidateQueries({ queryKey: themePresetQueryKeys.all })
      value.applyPreset(created)
      onClose()
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : 'Save failed.'),
  })
  const update = useMutation({
    mutationFn: ({ id, revision, document }: { id: string; revision: number; document: CustomThemeDocument }) =>
      client.themePresets.update(id, revision, document),
    onSuccess: (updated) => {
      void cache.invalidateQueries({ queryKey: themePresetQueryKeys.all })
      if (value.presetId === updated.id) value.applyPreset(updated)
      onClose()
    },
    onError: (error) => {
      if (isHttpResponseError(error, 409)) setNotice('This theme changed elsewhere — reload it before saving.')
      else setNotice(error instanceof Error ? error.message : 'Save failed.')
    },
  })
  const saving = create.isPending || update.isPending

  return (
    <div className="mt-4 flex flex-col gap-3 text-sm">
      <p className="text-secondary">
        Changes preview across the app while you edit. Nothing is saved until you choose Save; Cancel restores your
        theme.
      </p>
      <div
        className={clsx(
          'grid min-w-0 auto-rows-max gap-4 lg:min-h-0 lg:auto-rows-auto',
          can('chat:send') && 'lg:grid-cols-[minmax(18rem,0.7fr)_minmax(0,2fr)]'
        )}
      >
        {can('chat:send') && (
          // tabIndex makes this a valid one-shot focus target for "New theme"
          // (see the `focusAssistant` effect above); it is not meant to be a
          // persistent tab stop otherwise. `order-2 lg:order-none` puts it
          // full-width BELOW the editor on narrow widths (source order would
          // otherwise place it above, ahead of the fields being described)
          // while restoring the side-by-side column order at `lg`.
          <div
            ref={assistantPanel}
            tabIndex={-1}
            className="order-2 min-w-0 min-h-[24rem] flex flex-col outline-none lg:order-none lg:min-h-0"
          >
            <PageEditorAssistant
              draft={editorDraft}
              onProposal={applyAssistantEdit}
              conversationDependencies={assistantDependencies}
              title={preset ? 'What would you like to change?' : 'What theme do you want?'}
              subtitle="Build and refine your theme together. Changes preview live across the app and can be undone."
              conversationTitle="Design a theme"
              instructions={assistantEditorInstructionsByKind.theme}
              tools={assistantEditorToolDefinitionsByKind.theme}
            />
          </div>
        )}
        <div className="order-1 flex min-w-0 flex-col gap-3 lg:order-none">
          <div className="flex items-center justify-end gap-1">
            <button
              type="button"
              className="ficus-button ficus-button-ghost flex h-8 w-8 items-center justify-center rounded-md disabled:opacity-40"
              aria-label="Undo"
              title="Undo"
              disabled={past.length === 0}
              onClick={() =>
                applyAssistantEdit({
                  id: 'manual-undo',
                  baseRevision: revision,
                  summary: 'Undo',
                  document: draft,
                  historyAction: 'undo',
                })
              }
            >
              <UndoIcon className="h-4 w-4" />
            </button>
            <button
              type="button"
              className="ficus-button ficus-button-ghost flex h-8 w-8 items-center justify-center rounded-md disabled:opacity-40"
              aria-label="Redo"
              title="Redo"
              disabled={future.length === 0}
              onClick={() =>
                applyAssistantEdit({
                  id: 'manual-redo',
                  baseRevision: revision,
                  summary: 'Redo',
                  document: draft,
                  historyAction: 'redo',
                })
              }
            >
              <RedoIcon className="h-4 w-4" />
            </button>
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
              <label className="flex flex-col gap-1">
                Theme name
                <input
                  className="ficus-field px-3 py-2"
                  value={draft.name}
                  maxLength={40}
                  onChange={(event) => commitTypedDraft('name', { ...draft, name: event.target.value })}
                  onBlur={closeTypingSession}
                />
              </label>
              <label className="flex flex-col gap-1">
                Based on
                <select
                  className="ficus-field px-3 py-2"
                  value={draft.base}
                  aria-describedby={baseHintId}
                  onChange={(event) => {
                    const next = reshapeForBase(draft, event.target.value)
                    commitDraft(next)
                    setTab(findWebTheme(next.base).kind === 'unified' ? 'constant' : valueRef.current.theme)
                  }}
                >
                  {BUILT_IN_THEMES.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p id={baseHintId} className="text-muted text-xs">
              Colors you don&rsquo;t set come from {base.label}, which also decides whether the theme has light and dark
              versions.
            </p>
          </div>
          <div className="rounded-lg border border-th-border p-3 flex flex-col gap-4">
            <div>
              <h4 className="font-medium text-primary">Palette</h4>
              <p className="text-muted text-xs">
                Pick the colors to build the theme from. Secondary and Tertiary follow Primary until you change them;
                leave them all blank for a plain, token-by-token theme.
              </p>
            </div>
            {/* Every seed field shares one layout and width: single column on
             * mobile, an even 2x2 grid from sm up (see web-ui.md's spacing
             * guidance). All four always render: a seed set before Primary
             * starts from the base's primary (see paletteDraft). */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <ColorField
                label="Primary"
                value={palette?.primary ?? ''}
                onChange={(next) => setPaletteTyped('primary', next ? { primary: next } : null)}
                onSwatchChange={(next) => setPaletteImmediate(next ? { primary: next } : null)}
                onBlur={closeTypingSession}
              />
              <ColorField
                label="Secondary"
                value={palette?.secondary ?? ''}
                onChange={(next) => setPaletteTyped('secondary', { secondary: next || undefined })}
                onSwatchChange={(next) => setPaletteImmediate({ secondary: next || undefined })}
                onClear={() => setPaletteImmediate({ secondary: undefined })}
                onBlur={closeTypingSession}
              />
              <ColorField
                label="Tertiary"
                value={palette?.tertiary ?? ''}
                onChange={(next) => setPaletteTyped('tertiary', { tertiary: next || undefined })}
                onSwatchChange={(next) => setPaletteImmediate({ tertiary: next || undefined })}
                onClear={() => setPaletteImmediate({ tertiary: undefined })}
                onBlur={closeTypingSession}
              />
              <ColorField
                label="Neutral"
                value={palette?.neutral ?? ''}
                onChange={(next) => setPaletteTyped('neutral', { neutral: next || undefined })}
                onSwatchChange={(next) => setPaletteImmediate({ neutral: next || undefined })}
                onClear={() => setPaletteImmediate({ neutral: undefined })}
                onBlur={closeTypingSession}
              />
            </div>
            {palette && (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <span className="text-secondary text-sm">Contrast</span>
                  <SegmentedControl
                    ariaLabel="Contrast"
                    options={CONTRAST_OPTIONS}
                    value={palette.contrast ?? 'standard'}
                    onChange={(level) => setPaletteImmediate({ contrast: level })}
                    className="w-full"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <span className="text-secondary text-sm">Status colors</span>
                  <SegmentedControl
                    ariaLabel="Status colors"
                    options={STATUS_MODE_OPTIONS}
                    value={palette.status ?? 'static'}
                    onChange={(mode) => setPaletteImmediate({ status: mode })}
                    className="w-full"
                  />
                  <p className="text-muted text-xs">
                    Harmonized tints warnings, errors and success toward your colors; meanings stay the same.
                  </p>
                </div>
              </div>
            )}
          </div>
          {!validation.ok && <p role="alert">{validation.error}</p>}
          {previewError && <p role="alert">{previewError}</p>}
          <details className="rounded-lg border border-th-border p-3">
            <summary className="cursor-pointer font-medium text-primary">Advanced: per-token overrides</summary>
            <div className="mt-3 flex flex-col gap-3">
              <div className="flex flex-wrap gap-3">
                {base.kind === 'dual' && (
                  <SegmentedControl
                    size="compact"
                    ariaLabel="Editing variant"
                    options={EDITING_VARIANT_OPTIONS}
                    // Only dual themes show this; switching to one resets `tab` to a variant.
                    value={tab === 'dark' ? 'dark' : 'light'}
                    onChange={setTab}
                  />
                )}
              </div>
              <label className="flex flex-col gap-1">
                Color token
                <select
                  className="ficus-field px-3 py-2"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                >
                  {ACTIVE_THEME_TOKENS.map((name) => (
                    <option key={name}>{name}</option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                Color value
                <input
                  className="ficus-field px-3 py-2"
                  value={color}
                  onChange={(event) => setColor(event.target.value)}
                  aria-describedby="custom-color-help"
                />
              </label>
              <p id="custom-color-help" className="text-muted">
                Hex, integer rgb(), or rgba() with alpha 0–1. Status edits include the full status palette; removing one
                restores that entire set. Inherited sentinels and opacity are preserved. Editing the{' '}
                {tab === 'constant' ? 'single' : tab} variant.
              </p>
              <button
                className="ficus-button min-h-[44px] px-3 py-2 ficus-button-secondary self-start"
                onClick={() => override(token, color)}
              >
                Preview token
              </button>
              <ul className="max-h-48 overflow-auto">
                {Object.entries(overrides).map(([name, value]) => (
                  <li key={name} className="flex flex-wrap items-center gap-2 py-1">
                    <span>
                      {name}: {value}
                    </span>
                    <button
                      className="ficus-button min-h-[44px] px-3 py-2 ficus-button-secondary"
                      aria-label={`Remove ${name}`}
                      onClick={() => removeOverride(name)}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
              {warnings.length > 0 && (
                <div aria-label="Contrast warnings" className="max-h-64 overflow-auto">
                  <p>
                    Informational contrast warnings — these do not block Save. Surfaces are checked over the live page;
                    a translucent page may have an unknown backdrop.
                  </p>
                  <ul>
                    {warnings.map(({ pair, ratio, safe }) => (
                      <li key={`${pair.fg}/${pair.bg}/${pair.under}`} className="py-2">
                        {pair.fg} on {pair.bg}
                        {pair.under ? ` over ${pair.under}` : ''}:{' '}
                        {ratio === null
                          ? 'Contrast unknown: the translucent backdrop does not resolve to an opaque page or surface.'
                          : `${ratio.toFixed(2)}:1 (recommended ${pair.minimum}:1).`}
                        {safe && (
                          <button
                            className="ficus-button min-h-[44px] px-3 py-2 ficus-button-secondary ml-2"
                            onClick={() => override(pair.fg, safe)}
                          >
                            Use safe value {safe}
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </details>
          <div className="flex flex-wrap gap-2">
            <button
              className="ficus-button min-h-[44px] px-3 py-2 ficus-button-primary"
              disabled={!validation.ok || !!previewError || saving}
              onClick={() => {
                closeTypingSession()
                if (!validation.ok) return
                if (preset) update.mutate({ id: preset.id, revision: preset.revision, document: validation.document })
                else create.mutate(validation.document)
              }}
            >
              {preset ? 'Save' : 'Save as new'}
            </button>
            {preset && (
              <button
                className="ficus-button min-h-[44px] px-3 py-2 ficus-button-secondary"
                disabled={!validation.ok || saving}
                onClick={() => {
                  closeTypingSession()
                  if (validation.ok) create.mutate(validation.document)
                }}
              >
                Save as new
              </button>
            )}
            <button
              className="ficus-button min-h-[44px] px-3 py-2 ficus-button-secondary"
              disabled={saving}
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              className="ficus-button min-h-[44px] px-3 py-2 ficus-button-secondary"
              disabled={!validation.ok}
              onClick={download}
            >
              Export JSON
            </button>
          </div>
          {notice && <p role="status">{notice}</p>}
        </div>
      </div>
    </div>
  )
}
