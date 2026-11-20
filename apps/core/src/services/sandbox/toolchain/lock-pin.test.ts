import { describe, expect, it } from 'bun:test'
import { checkToolchainLock, MAX_TOOLCHAIN_LOCK_BYTES, TOOLCHAIN_STDENV_LOCK_KEY } from './lock-pin'

const REV = 'c7def046b9a883d46974757852106483d741586f'
const NAR = 'narHash=sha256-6RSEDHIWQtesQKWSu5qRai8L2h4KgCgMEfJHstW99G4%3D'

// The shape Devbox 0.14 wrote for a managed toolchain of `bun` and
// `jq@latest` on an agent box (2026-11-20), trimmed to one system.
function lock(packages: Record<string, unknown>): string {
  return JSON.stringify({ lockfile_version: '1', packages }, null, 2)
}

const valid = {
  bun: { resolved: `github:NixOS/nixpkgs/${REV}?${NAR}#bun`, source: 'nixpkg' },
  'jq@latest': {
    last_modified: '2026-08-05T07:53:23Z',
    resolved: 'github:NixOS/nixpkgs/3a971fa2e67dcb0f2f2cfed2d37e7956567d73d1#jq',
    source: 'devbox-search',
    version: '1.8.2',
    systems: {
      'x86_64-linux': {
        outputs: [{ name: 'bin', path: '/nix/store/7nk0xd0i3x9wlgyr8g4hyp4z4i2gmw2v-jq-1.8.2-bin', default: true }],
        store_path: '/nix/store/7nk0xd0i3x9wlgyr8g4hyp4z4i2gmw2v-jq-1.8.2-bin',
      },
    },
  },
  [TOOLCHAIN_STDENV_LOCK_KEY]: { resolved: `github:NixOS/nixpkgs/${REV}?lastModified=1789370336&${NAR}` },
}
const packages = ['bun', 'jq@latest']

describe('managed toolchain lock pin validation', () => {
  it('accepts the lock Devbox writes for exactly the declared packages', () => {
    expect(checkToolchainLock(lock(valid), packages)).toEqual({ ok: true })
  })

  it('rejects corrupt or non-Devbox content', () => {
    expect(checkToolchainLock('{"lockfile_version": "1", "packages": {', packages)).toMatchObject({ ok: false })
    expect(checkToolchainLock('[]', packages)).toMatchObject({ ok: false })
    expect(checkToolchainLock(JSON.stringify({ packages: valid }), packages)).toMatchObject({ ok: false })
    expect(checkToolchainLock(' '.repeat(MAX_TOOLCHAIN_LOCK_BYTES + 1), packages)).toMatchObject({ ok: false })
  })

  it('rejects a lock for a different package set', () => {
    expect(checkToolchainLock(lock(valid), ['bun', 'jq@latest', 'go@latest'])).toMatchObject({
      ok: false,
      reason: 'missing go@latest',
    })
    expect(checkToolchainLock(lock(valid), ['bun'])).toMatchObject({ ok: false, reason: 'undeclared entry jq@latest' })
  })

  it('rejects references that are not an exact official nixpkgs commit', () => {
    for (const resolved of [
      'github:attacker/nixpkgs/c7def046b9a883d46974757852106483d741586f#bun',
      'github:NixOS/nixpkgs/nixpkgs-unstable#bun',
      'github:NixOS/nixpkgs/c7def04#bun',
      'path:/tmp/nixpkgs#bun',
    ]) {
      expect(checkToolchainLock(lock({ ...valid, bun: { resolved } }), packages)).toMatchObject({ ok: false })
    }
    expect(checkToolchainLock(lock({ ...valid, bun: { source: 'nixpkg' } }), packages)).toMatchObject({ ok: false })
  })

  it('rejects outputs outside the Nix store', () => {
    const jq = valid['jq@latest']
    const withPath = (path: string) =>
      lock({
        ...valid,
        'jq@latest': { ...jq, systems: { 'x86_64-linux': { outputs: [{ name: 'bin', path }] } } },
      })
    expect(checkToolchainLock(withPath('/tmp/jq'), packages)).toMatchObject({ ok: false })
    expect(checkToolchainLock(withPath('/nix/store/../../tmp/jq'), packages)).toMatchObject({ ok: false })
    expect(
      checkToolchainLock(
        lock({ ...valid, 'jq@latest': { ...jq, systems: { 'x86_64-linux': { store_path: '/home/box/jq' } } } }),
        packages
      )
    ).toMatchObject({ ok: false })
  })
})
