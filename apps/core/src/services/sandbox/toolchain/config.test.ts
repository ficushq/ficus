import { describe, expect, it } from 'bun:test'
import { fingerprintToolchain, isEmptyToolchain, normalizeToolchain, renderManagedDevbox } from './config'

describe('managed toolchain configuration', () => {
  it('normalizes package order and duplicates', () => {
    expect(normalizeToolchain({ packages: [' python3@latest ', 'bun@latest', 'python3@latest'] })).toEqual({
      packages: ['bun@latest', 'python3@latest'],
    })
  })

  it('fingerprints equivalent package order identically', () => {
    expect(fingerprintToolchain({ packages: ['a', 'b'] })).toBe(fingerprintToolchain({ packages: ['b', 'a'] }))
  })

  it('changes its fingerprint when script or packages change', () => {
    expect(fingerprintToolchain({ packages: ['a'] })).not.toBe(fingerprintToolchain({ packages: ['b'] }))
    expect(fingerprintToolchain({ packages: ['a'], setupScript: 'echo one' })).not.toBe(
      fingerprintToolchain({ packages: ['a'], setupScript: 'echo two' })
    )
  })

  it('renders deterministic managed Devbox JSON', () => {
    expect(renderManagedDevbox({ packages: ['b', 'a'] })).toBe(`{
  "$schema": "https://raw.githubusercontent.com/jetify-com/devbox/0.14.0/.schema/devbox.schema.json",
  "packages": [
    "a",
    "b"
  ],
  "shell": {
    "init_hook": [],
    "scripts": {}
  }
}\n`)
  })

  it('includes private managed init hooks and readiness in deterministic fingerprints', () => {
    const base = {
      packages: ['nodejs@24.12.0'],
      initHooks: ['export PATH="$DEVBOX_PROJECT_ROOT/npm/bin:$PATH"'],
      readiness: [{ id: 'notion-cli', command: 'ntn --version', expectedSubstring: '0.23.25' }],
    }
    expect(fingerprintToolchain(base)).not.toBe(fingerprintToolchain({ ...base, initHooks: [] }))
    expect(JSON.parse(renderManagedDevbox(base)).shell.init_hook).toEqual(base.initHooks)
  })

  it('identifies declarations without packages or setup as empty', () => {
    expect(isEmptyToolchain({ packages: [] })).toBe(true)
    expect(isEmptyToolchain({ packages: [], setupScript: 'echo ready' })).toBe(false)
  })
})
