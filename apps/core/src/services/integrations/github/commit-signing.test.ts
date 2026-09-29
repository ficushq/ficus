import { describe, expect, it } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  GitHubCommitSigning,
  GitHubSignRefused,
  GitHubSigningError,
  githubSigningKeysApi,
  type GitHubCommitSigningDependencies,
} from './commit-signing'
import { githubSigningSecretKey, parseGitHubSigningRecord } from './commit-signing-store'

const TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const commitAs = (email: string) =>
  Buffer.from(`tree ${TREE}\nauthor A <${email}> 1 +0000\ncommitter A <${email}> 1 +0000\n\nmsg\n`)

function harness(
  options: {
    account?: boolean
    create?: GitHubCommitSigningDependencies['keys']['create']
    exists?: boolean | 'throw'
    connections?: string[]
    squadConnection?: string
    emails?: string[]
    setFails?: boolean
  } = {}
) {
  const secrets = new Map<string, string>()
  const calls: string[] = []
  let nextKeyId = 100
  const deps: GitHubCommitSigningDependencies = {
    secrets: {
      get: (key) => secrets.get(key),
      refreshKey: async () => {},
      set: async (key, value) => {
        if (options.setFails) throw new Error('secret store down')
        secrets.set(key, value)
      },
      delete: async (key) => {
        secrets.delete(key)
      },
    },
    keys: {
      create:
        options.create ??
        (async (_token, input) => {
          calls.push(`create:${input.title}`)
          return { id: nextKeyId++ }
        }),
      exists: async (_token, id) => {
        calls.push(`exists:${id}`)
        if (options.exists === 'throw') throw new Error('offline')
        return options.exists ?? true
      },
      remove: async (_token, id) => {
        calls.push(`remove:${id}`)
      },
    },
    account: async () =>
      options.account === false ? undefined : { accessToken: 'ghu_token', login: 'octo', userId: 7 },
    connectionIdsFor: async (userId) => {
      calls.push(`list:${userId}`)
      return options.connections ?? ['c1']
    },
    squadConnectionId: async () => options.squadConnection,
    signerEmails: async () => options.emails ?? ['7+octo@users.noreply.github.com'],
    reproject: async (id) => {
      calls.push(`reproject:${id}`)
    },
    keyTitle: () => 'Ficus commit signing (ficus.test)',
    now: () => new Date('2026-09-25T12:00:00Z'),
  }
  return { signing: new GitHubCommitSigning(deps), secrets, calls }
}

const record = (secrets: Map<string, string>, id = 'c1') =>
  parseGitHubSigningRecord(secrets.get(githubSigningSecretKey(id)))

describe('GitHubCommitSigning', () => {
  it('turning on registers a key on GitHub, keeps the private half and re-renders squad env', async () => {
    const { signing, secrets, calls } = harness()
    const status = await signing.enable('c1', 'user:noah')
    expect(calls).toEqual(['create:Ficus commit signing (ficus.test)', 'reproject:c1', 'exists:100'])
    const stored = record(secrets)
    expect(stored).toMatchObject({ state: 'on', githubKeyId: 100, enabledBy: 'user:noah' })
    expect(stored?.state === 'on' && stored.publicKey.startsWith('ssh-ed25519 ')).toBe(true)
    expect(status).toMatchObject({ state: 'on', registeredOnGitHub: true, enabledAt: '2026-09-25T12:00:00.000Z' })
    expect(status.fingerprint).toMatch(/^SHA256:/)
  })

  it('is idempotent while the key is on GitHub, and replaces a key someone deleted there', async () => {
    const present = harness()
    await present.signing.enable('c1', 'u')
    await present.signing.enable('c1', 'u')
    expect(present.calls.filter((call) => call.startsWith('create'))).toHaveLength(1)

    const gone = harness({ exists: false })
    await gone.signing.enable('c1', 'u')
    await gone.signing.enable('c1', 'u')
    expect(gone.calls.filter((call) => call.startsWith('create'))).toHaveLength(2)
    expect(record(gone.secrets)).toMatchObject({ githubKeyId: 101 })
  })

  it('refuses to turn on without a usable account, and passes GitHub permission errors through', async () => {
    await expect(harness({ account: false }).signing.enable('c1', 'u')).rejects.toMatchObject({
      code: 'connection_unusable',
    })
    const denied = harness({
      create: async () => {
        throw new GitHubSigningError('permission_missing', 'needs the permission')
      },
    })
    await expect(denied.signing.enable('c1', 'u')).rejects.toMatchObject({ code: 'permission_missing' })
    expect(record(denied.secrets)).toBeUndefined()
  })

  it('removes the GitHub key again when the private half cannot be stored', async () => {
    const { signing, calls } = harness({ setFails: true })
    await expect(signing.enable('c1', 'u')).rejects.toThrow('secret store down')
    expect(calls).toEqual(['create:Ficus commit signing (ficus.test)', 'remove:100'])
  })

  it('turning off deletes the GitHub key, drops the private key and is remembered', async () => {
    const { signing, secrets, calls } = harness()
    await signing.enable('c1', 'u')
    calls.length = 0
    expect(await signing.disable('c1', 'user:noah')).toEqual({ state: 'off' })
    expect(calls).toEqual(['remove:100', 'reproject:c1'])
    expect(record(secrets)).toEqual({
      version: 1,
      state: 'off',
      updatedAt: '2026-09-25T12:00:00.000Z',
      updatedBy: 'user:noah',
    })
    expect(secrets.get(githubSigningSecretKey('c1'))).not.toContain('PRIVATE KEY')
  })

  it('connect-time setup turns on only connections that never had a decision', async () => {
    const { signing, secrets, calls } = harness({ connections: ['c1', 'c2'] })
    await signing.disable('c1', 'u')
    calls.length = 0
    await signing.enableUndecided('user-9')
    // Only the connecting person's accounts are considered.
    expect(calls[0]).toBe('list:user-9')
    expect(record(secrets, 'c1')?.state).toBe('off')
    expect(record(secrets, 'c2')).toMatchObject({ state: 'on', enabledBy: 'user:user-9' })
    expect(calls.filter((call) => call.startsWith('create'))).toHaveLength(1)
  })

  it('connect-time setup survives a failing connection', async () => {
    const { signing } = harness({
      create: async () => {
        throw new GitHubSigningError('permission_missing', 'nope')
      },
    })
    await expect(signing.enableUndecided('user-9')).resolves.toBeUndefined()
  })

  it('removal cleanup forgets the key and deletes it from GitHub with the captured token', async () => {
    const { signing, secrets, calls } = harness()
    await signing.enable('c1', 'u')
    calls.length = 0
    const cleanup = await signing.prepareRemoval('c1', 'ghu_token')
    // Nothing happens until the removal commits.
    expect(calls).toEqual([])
    expect(record(secrets)?.state).toBe('on')
    await cleanup!()
    expect(calls).toEqual(['remove:100'])
    expect(secrets.has(githubSigningSecretKey('c1'))).toBe(false)
    expect(await harness().signing.prepareRemoval('never', 'ghu_token')).toBeUndefined()
  })

  it('status reports off, and "unknown" when GitHub cannot be asked', async () => {
    expect(await harness().signing.status('c1')).toEqual({ state: 'off' })
    const offline = harness({ exists: 'throw' })
    await offline.signing.enable('c1', 'u')
    expect((await offline.signing.status('c1')).registeredOnGitHub).toBeNull()
  })

  describe('sign', () => {
    it('signs commits committed as an allowed identity with a signature ssh-keygen verifies', async () => {
      const { signing, secrets } = harness({ squadConnection: 'c1', emails: ['Agent@Example.com'] })
      await signing.enable('c1', 'u')
      const payload = commitAs('agent@example.com')
      const signature = await signing.sign({ squadId: 's1', agentId: 'a1', payload })

      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tau-sign-')))
      try {
        const stored = record(secrets)
        if (stored?.state !== 'on') throw new Error('expected an on record')
        writeFileSync(join(dir, 'allowed'), `agent@example.com ${stored.publicKey}\n`)
        writeFileSync(join(dir, 'sig'), signature)
        const verify = Bun.spawnSync(
          [
            'ssh-keygen',
            '-Y',
            'verify',
            '-f',
            join(dir, 'allowed'),
            '-I',
            'agent@example.com',
            '-n',
            'git',
            '-s',
            join(dir, 'sig'),
          ],
          { stdin: payload, stdout: 'pipe', stderr: 'pipe' }
        )
        expect(verify.exitCode).toBe(0)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('refuses without a connection, with signing off, for non-git payloads and for other identities', async () => {
      await expect(
        harness().signing.sign({ squadId: 's1', agentId: 'a1', payload: commitAs('7+octo@users.noreply.github.com') })
      ).rejects.toMatchObject({ code: 'not_configured' })

      const off = harness({ squadConnection: 'c1' })
      await expect(
        off.signing.sign({ squadId: 's1', agentId: 'a1', payload: commitAs('7+octo@users.noreply.github.com') })
      ).rejects.toMatchObject({ code: 'signing_off' })

      const on = harness({ squadConnection: 'c1' })
      await on.signing.enable('c1', 'u')
      await expect(
        on.signing.sign({ squadId: 's1', agentId: 'a1', payload: Buffer.from('not a commit') })
      ).rejects.toMatchObject({ code: 'invalid_payload' })
      const mismatch = on.signing.sign({ squadId: 's1', agentId: 'a1', payload: commitAs('someone@else.com') })
      await expect(mismatch).rejects.toBeInstanceOf(GitHubSignRefused)
      await expect(mismatch).rejects.toMatchObject({ code: 'identity_mismatch' })
    })
  })
})

describe('githubSigningKeysApi', () => {
  const api = (status: number, body?: unknown) => {
    const requests: Array<{ url: string; method?: string; body?: string }> = []
    return {
      requests,
      keys: githubSigningKeysApi(async (url, init) => {
        requests.push({ url, method: init?.method, body: init?.body as string | undefined })
        return new Response(body === undefined ? null : JSON.stringify(body), { status })
      }),
    }
  }

  it('registers a signing key and reads its id', async () => {
    const { keys, requests } = api(201, { id: 42, key: 'ssh-ed25519 AAAA' })
    expect(await keys.create('t', { title: 'Ficus', key: 'ssh-ed25519 AAAA x' })).toEqual({ id: 42 })
    expect(requests[0]).toMatchObject({
      url: 'https://api.github.com/user/ssh_signing_keys',
      method: 'POST',
      body: JSON.stringify({ title: 'Ficus', key: 'ssh-ed25519 AAAA x' }),
    })
  })

  it('maps a missing App permission, a rejected key and other failures', async () => {
    await expect(api(403).keys.create('t', { title: 'x', key: 'k' })).rejects.toMatchObject({
      code: 'permission_missing',
    })
    await expect(api(404).keys.create('t', { title: 'x', key: 'k' })).rejects.toMatchObject({
      code: 'permission_missing',
    })
    await expect(api(422).keys.create('t', { title: 'x', key: 'k' })).rejects.toMatchObject({ code: 'key_rejected' })
    await expect(api(500).keys.create('t', { title: 'x', key: 'k' })).rejects.toMatchObject({
      code: 'github_unavailable',
    })
  })

  it('treats a key already gone as removed, and reports whether it still exists', async () => {
    await expect(api(404).keys.remove('t', 1)).resolves.toBeUndefined()
    await expect(api(204).keys.remove('t', 1)).resolves.toBeUndefined()
    await expect(api(500).keys.remove('t', 1)).rejects.toMatchObject({ code: 'github_unavailable' })
    expect(await api(200, { id: 1 }).keys.exists('t', 1)).toBe(true)
    expect(await api(404).keys.exists('t', 1)).toBe(false)
    await expect(api(502).keys.exists('t', 1)).rejects.toThrow()
  })
})
