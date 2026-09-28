import { useOptionalTheme } from '../providers/ThemeProvider'

interface FicusLogoProps {
  className?: string
  /** Pixel size. At `size <= 16` the simplified single-leaf mark is used, whose
   * detail survives at favicon scale; the full mark (leaf + pot) is used above
   * that. Omit it to size the mark with CSS instead (as the header wordmark does). */
  size?: number
}

/**
 * The Ficus mark: inlined path data from `brand/ficus-mark.svg` (light) and
 * `brand/ficus-mark-dark.svg` (dark, Core repo), picked by the resolved
 * appearance from `ThemeProvider`. Outside a `ThemeProvider` (e.g. a
 * standalone render) it falls back to the light mark. Platform web's
 * `FicusLogo` shares this props contract (`className`/`size`, `size <= 16` →
 * simplified mark) but always renders the dark palette — see its own doc
 * comment for why.
 */
export function FicusLogo({ className = 'w-8 h-8', size }: FicusLogoProps) {
  const theme = useOptionalTheme()
  const dark = theme?.theme === 'dark'
  const dimensions = size !== undefined ? { width: size, height: size } : {}

  if (size !== undefined && size <= 16) {
    // Same recolor the generator applies to brand/ficus-favicon-16.svg for
    // web/dark (see scripts/brand/generate.ts's DARK_RECOLOR map).
    const leaf = dark ? '#5e7f4e' : '#3f6b4f'
    const pot = dark ? '#c46a3c' : '#b0582f'
    return (
      <svg
        className={className}
        {...dimensions}
        viewBox="0 0 64 64"
        xmlns="http://www.w3.org/2000/svg"
        role="img"
        aria-label="Ficus"
      >
        <g transform="translate(32 38) scale(1.2)">
          <path
            d="M0 0 C9 -5 12.5 -16 7 -22.5 C4.8 -25.2 2.4 -27.6 0 -30 C-2.4 -27.6 -4.8 -25.2 -7 -22.5 C-12.5 -16 -9 -5 0 0 Z"
            fill={leaf}
          />
        </g>
        <rect x="12" y="36" width="40" height="9" rx="3" fill={pot} />
        <path d="M15 45 H49 L45 62 H19 Z" fill={pot} />
      </svg>
    )
  }

  const sideLeaf = dark ? '#87945a' : '#8a9a5b'
  const centerLeaf = dark ? '#5e7f4e' : '#3f6b4f'
  const pot = dark ? '#c46a3c' : '#b0582f'

  return (
    <svg
      className={className}
      {...dimensions}
      viewBox="0 0 64 64"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Ficus"
    >
      {/* translate(0 -2.5) centers the artwork's bounding box in the viewBox
          — see brand/ficus-mark.svg / brand/ficus-mark-dark.svg. */}
      <g transform="translate(0 -2.5)">
        <g transform="translate(32 39) rotate(-36) scale(0.78 0.84)">
          <path
            d="M0 0 C9 -5 12.5 -16 7 -22.5 C4.8 -25.2 2.4 -27.6 0 -30 C-2.4 -27.6 -4.8 -25.2 -7 -22.5 C-12.5 -16 -9 -5 0 0 Z"
            fill={sideLeaf}
          />
        </g>
        <g transform="translate(32 39) rotate(36) scale(0.78 0.84)">
          <path
            d="M0 0 C9 -5 12.5 -16 7 -22.5 C4.8 -25.2 2.4 -27.6 0 -30 C-2.4 -27.6 -4.8 -25.2 -7 -22.5 C-12.5 -16 -9 -5 0 0 Z"
            fill={sideLeaf}
          />
        </g>
        <g transform="translate(32 39)">
          <path
            d="M0 0 C9 -5 12.5 -16 7 -22.5 C4.8 -25.2 2.4 -27.6 0 -30 C-2.4 -27.6 -4.8 -25.2 -7 -22.5 C-12.5 -16 -9 -5 0 0 Z"
            fill={centerLeaf}
          />
        </g>
        <rect x="18" y="39" width="28" height="5" rx="2.5" fill={pot} />
        <path d="M20 44 H44 L41 59 Q40.6 60 39.5 60 H24.5 Q23.4 60 23 59 Z" fill={pot} />
      </g>
    </svg>
  )
}
