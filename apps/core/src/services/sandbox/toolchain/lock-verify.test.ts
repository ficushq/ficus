import { beforeEach, describe, expect, it } from 'bun:test'
import { TOOLCHAIN_STDENV_LOCK_KEY } from './lock-pin'
import { buildVerifiedPin, checkStoredPin, resetLockVerificationMemory } from './lock-verify'

const UPSTREAM = '3a971fa2e67dcb0f2f2cfed2d37e7956567d73d1'
const FORK = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
const SEED_REV = 'f4b6996c4e8b9ee06ce147ec344c885f51071b14'
const SEED_STDENV = `github:NixOS/nixpkgs/${SEED_REV}?lastModified=1786963906&narHash=sha256-3tkeMWSvHPo3tYljfXbPC%2FTgknikU1GvdVr%2FDkdfvE0%3D`
const JQ_PATH = '/nix/store/4b6f9wb1qak318gk7mxlfkhril6lxpcx-jq-1.8.2-bin'
const FAKE_PATH = '/nix/store/00000000000000000000000000000000-jq-1.8.2-bin'

function jqEntry(rev = UPSTREAM, path = JQ_PATH) {
  return {
    last_modified: '2026-08-05T07:53:23Z',
    resolved: `github:NixOS/nixpkgs/${rev}#jq`,
    source: 'devbox-search',
    version: '1.8.2',
    systems: { 'x86_64-linux': { outputs: [{ name: 'bin', path, default: true }], store_path: path } },
  }
}

// The shape a fresh Devbox resolution leaves in the box: the stdenv is the
// current nixpkgs-unstable tip, with a narHash the box chose.
function captured(jq: unknown = jqEntry()): string {
  return JSON.stringify({
    lockfile_version: '1',
    packages: {
      'jq@latest': jq,
      [TOOLCHAIN_STDENV_LOCK_KEY]: {
        resolved: `github:NixOS/nixpkgs/${UPSTREAM}?lastModified=1&narHash=sha256-planted%3D`,
      },
    },
  })
}

/** GitHub and cache.nixos.org as seen by Core; fork commits diverge from upstream. */
function fakeNetwork(options: { cached?: string[]; upstream?: string[]; fail?: 'github' | 'cache' } = {}) {
  const upstream = new Set(options.upstream ?? [UPSTREAM, SEED_REV])
  const cached = new Set(options.cached ?? ['4b6f9wb1qak318gk7mxlfkhril6lxpcx'])
  const requests: string[] = []
  const fetch = async (url: string, init: RequestInit) => {
    requests.push(`${init.method ?? 'GET'} ${url}`)
    const compare = /\/repos\/NixOS\/nixpkgs\/compare\/nixpkgs-unstable\.\.\.([0-9a-f]{40})\?per_page=1$/.exec(url)
    if (compare) {
      if (options.fail === 'github') return new Response('{"message":"API rate limit exceeded"}', { status: 403 })
      const sha = compare[1]!
      return Response.json(
        upstream.has(sha)
          ? { status: 'behind', merge_base_commit: { sha } }
          : { status: 'diverged', merge_base_commit: { sha: UPSTREAM } }
      )
    }
    const narinfo = /^https:\/\/cache\.nixos\.org\/([0-9a-z]{32})\.narinfo$/.exec(url)
    if (narinfo) {
      if (options.fail === 'cache') throw new Error('network unreachable')
      return new Response(null, { status: cached.has(narinfo[1]!) ? 200 : 404 })
    }
    return new Response(null, { status: 500 })
  }
  return { fetch, requests }
}

describe('managed toolchain lock verification', () => {
  beforeEach(() => resetLockVerificationMemory())

  it('builds the pin from upstream commits, cached store paths and the trusted stdenv', async () => {
    const net = fakeNetwork()
    const result = await buildVerifiedPin(captured(), ['jq@latest'], SEED_STDENV, net)
    expect(result.ok).toBe(true)
    const pin = JSON.parse((result as { lock: string }).lock)
    expect(pin.packages['jq@latest']).toEqual(jqEntry())
    // The box's stdenv (and its narHash) is discarded for Core's own.
    expect(pin.packages[TOOLCHAIN_STDENV_LOCK_KEY]).toEqual({ resolved: SEED_STDENV })
    expect(net.requests.sort()).toEqual([
      'GET https://api.github.com/repos/NixOS/nixpkgs/compare/nixpkgs-unstable...3a971fa2e67dcb0f2f2cfed2d37e7956567d73d1?per_page=1',
      'GET https://api.github.com/repos/NixOS/nixpkgs/compare/nixpkgs-unstable...f4b6996c4e8b9ee06ce147ec344c885f51071b14?per_page=1',
      'HEAD https://cache.nixos.org/4b6f9wb1qak318gk7mxlfkhril6lxpcx.narinfo',
    ])
    expect(checkStoredPin((result as { lock: string }).lock, ['jq@latest'])).toEqual({ ok: true })
  })

  it('pins without a stdenv entry when Core has no trusted one', async () => {
    const result = await buildVerifiedPin(captured(), ['jq@latest'], undefined, fakeNetwork())
    const pin = JSON.parse((result as { lock: string }).lock)
    expect(Object.keys(pin.packages)).toEqual(['jq@latest'])
  })

  it('rejects a planted fork commit served under the NixOS/nixpkgs path', async () => {
    const result = await buildVerifiedPin(captured(jqEntry(FORK)), ['jq@latest'], SEED_STDENV, fakeNetwork())
    expect(result).toEqual({ ok: false, reason: `commit ${FORK} is not part of upstream nixpkgs-unstable` })
  })

  it('rejects a trusted stdenv whose commit is not upstream', async () => {
    const net = fakeNetwork({ upstream: [UPSTREAM] })
    expect(await buildVerifiedPin(captured(), ['jq@latest'], SEED_STDENV, net)).toMatchObject({ ok: false })
  })

  it('rejects a store path the official cache does not serve', async () => {
    const result = await buildVerifiedPin(
      captured(jqEntry(UPSTREAM, FAKE_PATH)),
      ['jq@latest'],
      SEED_STDENV,
      fakeNetwork()
    )
    expect(result).toEqual({
      ok: false,
      reason: 'store path 00000000000000000000000000000000 is not served by https://cache.nixos.org',
    })
  })

  it('checks store paths for every system, not just the local one', async () => {
    const jq = jqEntry()
    const withArm = { ...jq, systems: { ...jq.systems, 'aarch64-linux': { store_path: FAKE_PATH } } }
    expect(await buildVerifiedPin(captured(withArm), ['jq@latest'], SEED_STDENV, fakeNetwork())).toMatchObject({
      ok: false,
    })
  })

  it('refuses content-hashed (bare) package entries without asking the network', async () => {
    const net = fakeNetwork()
    const bare = { resolved: `github:NixOS/nixpkgs/${UPSTREAM}?narHash=sha256-planted%3D#bun`, source: 'nixpkg' }
    const lock = JSON.stringify({ lockfile_version: '1', packages: { bun: bare } })
    expect(await buildVerifiedPin(lock, ['bun'], SEED_STDENV, net)).toMatchObject({ ok: false })
    expect(net.requests).toEqual([])
  })

  it('fails closed when GitHub refuses or the cache is unreachable', async () => {
    for (const fail of ['github', 'cache'] as const) {
      resetLockVerificationMemory()
      expect(await buildVerifiedPin(captured(), ['jq@latest'], SEED_STDENV, fakeNetwork({ fail }))).toMatchObject({
        ok: false,
      })
    }
  })

  it('rejects malformed captured content before any request', async () => {
    const net = fakeNetwork()
    expect(await buildVerifiedPin('{', ['jq@latest'], SEED_STDENV, net)).toMatchObject({ ok: false })
    expect(net.requests).toEqual([])
  })

  it('remembers verified commits and paths instead of asking again', async () => {
    const net = fakeNetwork()
    await buildVerifiedPin(captured(), ['jq@latest'], SEED_STDENV, net)
    const first = net.requests.length
    await buildVerifiedPin(captured(), ['jq@latest'], SEED_STDENV, net)
    expect(net.requests.length).toBe(first)
  })

  it('rejects a stored pin whose package entry carries a content hash', () => {
    const hashed = captured({ ...jqEntry(), resolved: `github:NixOS/nixpkgs/${UPSTREAM}?narHash=sha256-x%3D#jq` })
    expect(checkStoredPin(hashed, ['jq@latest'])).toMatchObject({ ok: false })
  })
})
