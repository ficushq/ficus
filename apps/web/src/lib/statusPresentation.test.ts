import { describe, expect, test } from 'bun:test'
import type { StatusRole } from '@ficus/shared'
import colors from 'tailwindcss/colors'
import { acquireDomHarness } from '../test/domHarness'
import { WEB_STATUS, webStatus, readStatusMarkerColor } from './statusPresentation'
import { channelsToHex, contrastRatio, variants } from '../theme/test/palette'

// Independent compatibility oracle: the legacy Tailwind palette, not runtime classes.
const legacyRoleColors = {
  progress: 'blue',
  queue: 'cyan',
  review: 'yellow',
  humanWait: 'purple',
  externalWait: 'orange',
  attention: 'amber',
  danger: 'red',
  success: 'green',
  neutral: 'gray',
} as const satisfies Record<StatusRole, keyof typeof colors>

const tokenRole = (role: string) => role.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)

describe('web status presentation', () => {
  test('every role uses token utilities and retains the original resolved shades', () => {
    expect(Object.keys(WEB_STATUS).sort()).toEqual(Object.keys(legacyRoleColors).sort())
    for (const [role, color] of Object.entries(legacyRoleColors) as Array<
      [StatusRole, (typeof legacyRoleColors)[StatusRole]]
    >) {
      const prefix = `status-${tokenRole(role)}`
      const treatment = webStatus(role)
      expect(treatment.markerClass).toBe(`bg-${prefix}-solid`)
      expect(treatment.textClass).toBe(`text-${prefix}-fg`)
      expect(treatment.surfaceClass).toBe(`bg-${prefix}-surface`)
      expect(treatment.borderClass).toBe(`border-${prefix}-border`)
      expect(treatment.badgeColor).toBe(role)
      for (const [variant, fg, surface, border] of [
        ['light', 700, 50, 200],
        ['dark', 400, 900, 800],
      ] as const) {
        for (const [slot, shade] of [
          ['solid', 500],
          ['fg', fg],
          ['surface', surface],
          ['border', border],
        ] as const) {
          expect(channelsToHex(variants[variant][`--${prefix}-${slot}`]!)).toBe(colors[color][shade])
        }
        expect(Number(variants[variant][`--opacity-${prefix}-surface`])).toBe(variant === 'dark' ? 0.2 : 1)
      }
      expect(contrastRatio(channelsToHex(variants.light[`--${prefix}-fg`]!), '#ffffff')).toBeGreaterThanOrEqual(4.5)
    }
  })

  test('canvas colors are numeric, lazily resolved, and track token changes', async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/' })
    const root = document.createElement('div')
    document.body.append(root)
    try {
      root.style.setProperty('--status-progress-solid', '59 130 246')
      expect(readStatusMarkerColor('--status-progress-solid', root)).toBe('rgb(59, 130, 246)')
      root.style.setProperty('--status-progress-solid', '1 2 3')
      expect(readStatusMarkerColor('--status-progress-solid', root)).toBe('rgb(1, 2, 3)')
      root.style.removeProperty('--status-progress-solid')
      expect(readStatusMarkerColor('--status-progress-solid', root)).toBe('transparent')
    } finally {
      await dom.cleanup()
    }
  })
})
