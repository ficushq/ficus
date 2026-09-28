import { describe, expect, it } from 'bun:test'
import { desktopShell } from './shell'

const shell = { insetTitleBar: true, fullscreen: async () => false, onFullscreenChange: () => () => {} }

describe('desktopShell', () => {
  it('is absent in a plain browser', () => {
    expect(desktopShell({})).toBeUndefined()
  })

  it('reads the current and the renamed desktop bridge', () => {
    expect(desktopShell({ tauDesktopApp: { version: 1, shell } })).toBe(shell)
    expect(desktopShell({ ficusDesktopApp: { version: 1, shell } })).toBe(shell)
  })

  it('ignores unknown bridge versions and incomplete shells', () => {
    expect(desktopShell({ tauDesktopApp: { version: 2, shell } })).toBeUndefined()
    expect(desktopShell({ tauDesktopApp: { version: 1, shell: { insetTitleBar: true } } })).toBeUndefined()
  })
})
