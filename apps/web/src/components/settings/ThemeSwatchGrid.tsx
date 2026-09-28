import { useRef } from 'react'
import clsx from 'clsx'
import type { ThemePreset } from '@ficus/shared'
import { presetAppearance } from '../../theme/custom'
import { ThemeSwatch, type ThemeSwatchSpec } from '../ThemeSwatch'
import type { WebThemeDefinition } from '../../theme/registry'

export type ThemeGridOption =
  | { kind: 'builtin'; id: string; label: string; accessibleLabel: string; theme: WebThemeDefinition }
  | {
      kind: 'preset'
      id: string
      label: string
      accessibleLabel: string
      preset: Pick<ThemePreset, 'id' | 'document' | 'owner'>
    }

/**
 * Settings' Theme picker: a wrapping grid of theme preview dots (the same
 * `.theme-swatch` conic rendering ThemeQuickPicker and the "My themes"
 * library use — see ThemeSwatch's doc comment) with the theme's name under
 * each one. Native-radiogroup keyboard model: arrow keys move AND select
 * (wrapping at both ends, like a native `<input type="radio">` group);
 * Enter/Space select the focused dot explicitly. Roving tabindex keeps only
 * the active dot (or the first, before anything resolves) in the Tab order.
 *
 * Hovering a dot previews it through `onPreview`; `onPreviewEnd` fires when the pointer leaves the whole grid. The
 * tiles touch (no grid gap) so a sweep never crosses a gap between them. Every row is as tall as the tallest (a
 * two-line name) and each tile centres its dot and a two-line name box, so all dots and names line up.
 */
export function ThemeSwatchGrid({
  options,
  selectedId,
  currentAppearance,
  onSelect,
  previewingId = null,
  onPreview,
  onPreviewEnd,
  className,
}: {
  options: readonly ThemeGridOption[]
  selectedId: string | null
  currentAppearance: 'light' | 'dark'
  onSelect: (option: ThemeGridOption) => void
  /** The dot the pointer is previewing, if any. */
  previewingId?: string | null
  onPreview?: (option: ThemeGridOption) => void
  onPreviewEnd?: () => void
  className?: string
}) {
  const buttons = useRef(new Map<string, HTMLButtonElement>())
  const rovingIndex = Math.max(
    0,
    options.findIndex((option) => option.id === selectedId)
  )
  const move = (fromIndex: number, delta: number) => {
    if (options.length === 0) return
    const next = options[(fromIndex + delta + options.length) % options.length]!
    onSelect(next)
    buttons.current.get(next.id)?.focus()
  }
  return (
    <div
      role="radiogroup"
      aria-label="Color theme"
      className={clsx('grid auto-rows-fr grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))]', className)}
      onMouseLeave={onPreviewEnd}
    >
      {options.map((option, index) => {
        const selected = option.id === selectedId
        const previewing = option.id === previewingId
        const spec: ThemeSwatchSpec =
          option.kind === 'builtin'
            ? { kind: 'builtin', theme: option.theme, appearance: currentAppearance }
            : {
                kind: 'preset',
                document: option.preset.document,
                appearance: presetAppearance(option.preset.document, currentAppearance),
              }
        return (
          <button
            key={option.id}
            ref={(element) => {
              if (element) buttons.current.set(option.id, element)
              else buttons.current.delete(option.id)
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={option.accessibleLabel}
            tabIndex={index === rovingIndex ? 0 : -1}
            className="group flex min-h-[44px] flex-col items-center justify-center gap-1.5 rounded-lg px-2 py-3 text-center hover:bg-surface-hover focus:outline-none"
            onMouseEnter={() => onPreview?.(option)}
            onClick={() => onSelect(option)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onSelect(option)
                return
              }
              const delta =
                event.key === 'ArrowRight' || event.key === 'ArrowDown'
                  ? 1
                  : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
                    ? -1
                    : 0
              if (!delta) return
              event.preventDefault()
              move(index, delta)
            }}
          >
            <span className="relative block h-10 w-10 rounded-full">
              <ThemeSwatch
                spec={spec}
                ring={previewing ? 'on' : selected ? (previewingId ? 'dim' : 'on') : undefined}
                className="h-full w-full"
              />
            </span>
            {/* Every name reserves two lines, so each tile's dot and name block is the same height and the dots line up
                across a row even when one name wraps. */}
            <span className="h-8 w-full max-w-full line-clamp-2 break-normal text-center text-xs leading-4 text-secondary">
              {option.label}
            </span>
          </button>
        )
      })}
    </div>
  )
}
