import { describe, expect, it } from 'bun:test'
import { desktopShell } from './shell'

const shell = { insetTitleBar: true, fullscreen: async () => false, onFullscreenChange: () => () => {} }

describe('desktopShell', () => {
  it('is absent in a plain browser', () => {
    expect(desktopShell({})).toBeUndefined()
  })

  it('reads the Ficus desktop bridge', () => {
    expect(desktopShell({ ficusDesktopApp: { version: 1, shell } })).toBe(shell)
  })

  it('ignores the retired preload property', () => {
    expect(desktopShell({ tauDesktopApp: { version: 1, shell } })).toBeUndefined() // ficus-negative-test
  })

  it('ignores unknown bridge versions and incomplete shells', () => {
    expect(desktopShell({ ficusDesktopApp: { version: 2, shell } })).toBeUndefined()
    expect(desktopShell({ ficusDesktopApp: { version: 1, shell: { insetTitleBar: true } } })).toBeUndefined()
  })
})
