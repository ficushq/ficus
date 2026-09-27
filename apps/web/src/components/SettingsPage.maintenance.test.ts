import { describe, expect, it } from 'bun:test'
import { maintenanceControlDisabled, maintenanceStatusText } from './maintenance-status'

describe('maintenanceStatusText', () => {
  it('does not report normal operation while authoritative state is loading', () => {
    const text = maintenanceStatusText(undefined, true, false)
    expect(text).toBe('Loading maintenance state…')
    expect(text).not.toContain('accepting agent work normally')
  })

  it('disables maintenance mutation until authoritative state is available', () => {
    expect(maintenanceControlDisabled(false, false)).toBe(true)
    expect(maintenanceControlDisabled(true, false)).toBe(false)
    expect(maintenanceControlDisabled(true, true)).toBe(true)
  })

  it('reports unknown execution status when the maintenance query fails', () => {
    const text = maintenanceStatusText(undefined, false, true)
    expect(text).toBe('Maintenance state is unavailable. Ficus execution status is unknown.')
    expect(text).not.toContain('accepting agent work normally')
  })

  // Settled, no error flag, still no snapshot — a disabled or reset query.
  // Absent is not the same as "not paused": reporting normal operation here
  // would tell an operator work is flowing during a real pause.
  it('reports unknown execution status when state is absent without an explicit error', () => {
    expect(maintenanceStatusText(undefined, false, false)).toBe(
      'Maintenance state is unavailable. Ficus execution status is unknown.'
    )
  })
})
