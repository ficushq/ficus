import { useEffect, useRef, useState } from 'react'
import type { ThemePreset } from '@ficus/shared'
import { useOptionalThemePreview } from '../providers/ThemeProvider'
import { findWebTheme, type WebThemeDefinition } from '../theme/registry'
import { presetAppearance } from '../theme/custom'
import { paintRoot } from '../theme/preview'
import { useStableRef } from './useStableRef'

/** Sweeping across the circles must not strobe the whole app; only a settled hover previews. */
export const HOVER_PREVIEW_DELAY_MS = 100

/** What a theme circle previews: a built-in, or a preset's document. */
export type PreviewableTheme =
  | { kind: 'builtin'; id: string; theme: WebThemeDefinition }
  | { kind: 'preset'; id: string; preset: Pick<ThemePreset, 'document'> }

/** Whether a circle's theme has both a light and a dark appearance (a preset has its base theme's). */
export function hasAppearances(option: PreviewableTheme): boolean {
  return (option.kind === 'builtin' ? option.theme : findWebTheme(option.preset.document.base)).kind === 'dual'
}

/**
 * Hover preview shared by the header quick picker and Settings' theme grid: hovering a circle paints the whole app
 * with it (after the intent delay) without persisting anything.
 *
 * Moving from one circle to the next swaps the preview directly; only `end` (the pointer leaving the whole group,
 * closing, or choosing) restores the stored selection, so a sweep never flashes back to it in between. `hoveredId`
 * lets the circles show which one is being previewed. Outside ThemeProvider (static renders) nothing is painted.
 *
 * `appearance` is the app's current effective appearance; a palette-only preview keeps it.
 */
export function useThemeHoverPreview(appearance: 'light' | 'dark') {
  const previewSlot = useOptionalThemePreview()
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // The unregister function from the preview slot, or null while this component has no preview registered.
  const clearPreview = useRef<(() => void) | null>(null)
  const appearanceRef = useStableRef(appearance)

  const paint = (option: PreviewableTheme) => {
    if (!previewSlot) return
    const next = previewSlot.setPreview(() => {
      const root = document.documentElement
      if (option.kind === 'preset')
        paintRoot(
          root,
          findWebTheme(option.preset.document.base),
          presetAppearance(option.preset.document, appearanceRef.current),
          option.preset.document
        )
      // Keep the app's current appearance for light/dark themes; a one-appearance theme only has its constant
      // variant, and painting it as light/dark would drop its `dark` class and leave `dark:` styles in light mode.
      else paintRoot(root, option.theme, option.theme.kind === 'unified' ? 'constant' : appearanceRef.current, null)
    })
    clearPreview.current = next
  }

  const start = (option: PreviewableTheme) => {
    setHoveredId(option.id)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => paint(option), HOVER_PREVIEW_DELAY_MS)
  }

  const end = () => {
    setHoveredId(null)
    clearTimeout(timer.current)
    timer.current = undefined
    // A no-op if a later registrant (e.g. the editor opening mid-hover) has since taken over the slot — see
    // useThemePreview's doc comment.
    clearPreview.current?.()
    clearPreview.current = null
  }

  // If the picker unmounts mid-hover (e.g. navigating away), restore rather than leave a stale preview painted.
  useEffect(() => end, [])

  return { hoveredId, start, end }
}
