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
import { githubSigningSecretKey, parseGitHubSigningRecord, type GitHubSigningAccount } from './commit-signing-store'

const TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const commitAs = (email: string) =>
  Buffer.from(`tree ${TREE}\nauthor A <${email}> 1 +0000\ncommitter A <${email}> 1 +0000\n\nmsg\n`)

function harness(
  options: {
    account?: boolean
    create?: GitHubCommitSigningDependencies['keys']['create']
    exists?: boolean | 'throw'
    connections?: string[]
    /** GitHub connections attached to squad s1; other squads have none. */
    accounts?: Partial<GitHubSigningAccount>[]
    /** Public profile email per connection, on top of the noreply address. */
    profileEmails?: Record<string, string>
    setFails?: boolean
  } = {}
) {
  const secrets = new Map<string, string>()
  const calls: string[] = []
  let nextKeyId = 100
  const accounts: GitHubSigningAccount[] = (options.accounts ?? []).map((account, index) => ({
    connectionId: `c${index + 1}`,
    login: 'octo',
    userId: 7,
    isDefault: index === 0,
    canSign: true,
    ...account,
  }))
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
    squadAccounts: async (squadId) => (squadId === 's1' ? accounts : []),
    connectionAccount: async (connectionId) => accounts.find((account) => account.connectionId === connectionId),
    accountEmails: async (account) => {
      calls.push(`emails:${account.connectionId}`)
      const profile = options.profileEmails?.[account.connectionId]
      return [`${account.userId}+${account.login}@users.noreply.github.com`, ...(profile ? [profile] : [])]
    },
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
    const OCTO = '7+octo@users.noreply.github.com'
    const HUBOT = '9+hubot@users.noreply.github.com'
    const two = [
      { login: 'octo', userId: 7 },
      { login: 'hubot', userId: 9 },
    ]
    const sign = (signing: GitHubCommitSigning, email: string, squadId = 's1') =>
      signing.sign({ squadId, agentId: 'a1', payload: commitAs(email) })

    /** True when `signature` over `payload` was made with the key stored for the connection. */
    function signedBy(secrets: Map<string, string>, connectionId: string, payload: Buffer, signature: string) {
      const stored = record(secrets, connectionId)
      if (stored?.state !== 'on') throw new Error('expected an on record')
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ficus-sign-')))
      try {
        writeFileSync(join(dir, 'allowed'), `signer ${stored.publicKey}\n`)
        writeFileSync(join(dir, 'sig'), signature)
        const verify = Bun.spawnSync(
          [
            'ssh-keygen',
            '-Y',
            'verify',
            '-f',
            join(dir, 'allowed'),
            '-I',
            'signer',
            '-n',
            'git',
            '-s',
            join(dir, 'sig'),
          ],
          { stdin: payload, stdout: 'pipe', stderr: 'pipe' }
        )
        return verify.exitCode === 0
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }

    it("signs a default-account commit with that account's key, without looking anything up", async () => {
      const { signing, secrets, calls } = harness({ accounts: [{}] })
      await signing.enable('c1', 'u')
      const signature = await sign(signing, '7+Octo@Users.Noreply.GitHub.com')
      expect(signedBy(secrets, 'c1', commitAs('7+Octo@Users.Noreply.GitHub.com'), signature)).toBe(true)
      expect(calls.filter((call) => call.startsWith('emails:'))).toEqual([])
    })

    it("signs a commit committed as an account's public profile email", async () => {
      const { signing, secrets } = harness({ accounts: [{}], profileEmails: { c1: 'Octo@Example.com' } })
      await signing.enable('c1', 'u')
      const signature = await sign(signing, 'octo@example.com')
      expect(signedBy(secrets, 'c1', commitAs('octo@example.com'), signature)).toBe(true)
    })

    it("signs a commit committed as a non-default attached account with THAT account's key", async () => {
      const { signing, secrets } = harness({ accounts: two })
      await signing.enable('c1', 'u')
      await signing.enable('c2', 'u')
      const asDefault = await sign(signing, OCTO)
      const asOther = await sign(signing, HUBOT)
      expect(signedBy(secrets, 'c1', commitAs(OCTO), asDefault)).toBe(true)
      expect(signedBy(secrets, 'c2', commitAs(HUBOT), asOther)).toBe(true)
      expect(signedBy(secrets, 'c1', commitAs(HUBOT), asOther)).toBe(false)
      expect(signedBy(secrets, 'c2', commitAs(OCTO), asDefault)).toBe(false)
    })

    it('signs with a non-default account even when the default account has signing off', async () => {
      const { signing, secrets } = harness({ accounts: two })
      await signing.enable('c2', 'u')
      expect(signedBy(secrets, 'c2', commitAs(HUBOT), await sign(signing, HUBOT))).toBe(true)
      const asDefault = sign(signing, OCTO)
      await expect(asDefault).rejects.toMatchObject({ code: 'signing_off' })
      await expect(asDefault).rejects.toThrow('Commit signing is off for @octo')
    })

    it('refuses a committer no attached signing account owns, naming it and the accounts it can sign as', async () => {
      const { signing } = harness({ accounts: two, profileEmails: { c2: 'hubot@example.com' } })
      await signing.enable('c1', 'u')
      await signing.enable('c2', 'u')
      const refused = sign(signing, 'someone@else.com')
      await expect(refused).rejects.toBeInstanceOf(GitHubSignRefused)
      await expect(refused).rejects.toMatchObject({ code: 'identity_mismatch' })
      const message = await refused.catch((error: Error) => error.message)
      expect(message).toContain('committed as someone@else.com')
      expect(message).toContain(`@octo (default): ${OCTO}`)
      expect(message).toContain(`@hubot: ${HUBOT}, hubot@example.com`)
      expect(message).toContain('GIT_COMMITTER_EMAIL')
      expect(message).not.toMatch(/PRIVATE KEY|ssh-ed25519|SHA256:/)
    })

    it("never signs another account's email with the default key, whatever git identity the squad configured", async () => {
      // The squad's githubIdentity / GIT_USER_EMAIL is not an input of the signer at all: only account emails are.
      const attachedOff = harness({ accounts: two })
      await attachedOff.signing.enable('c1', 'u')
      await expect(sign(attachedOff.signing, HUBOT)).rejects.toMatchObject({ code: 'signing_off' })

      const notAttached = harness({ accounts: [{}] })
      await notAttached.signing.enable('c1', 'u')
      await expect(sign(notAttached.signing, HUBOT)).rejects.toMatchObject({ code: 'identity_mismatch' })
      await expect(sign(notAttached.signing, 'noah@example.com')).rejects.toMatchObject({ code: 'identity_mismatch' })
    })

    it('does not use a connection that may not sign, or one attached to another squad', async () => {
      // Disabled, other-authority and reauthorization-required connections arrive as canSign: false.
      const unusable = harness({ accounts: [{}, { login: 'hubot', userId: 9, canSign: false }] })
      await unusable.signing.enable('c1', 'u')
      await unusable.signing.enable('c2', 'u')
      await expect(sign(unusable.signing, HUBOT)).rejects.toMatchObject({ code: 'identity_mismatch' })

      const onlyUnusable = harness({ accounts: [{ canSign: false }] })
      await onlyUnusable.signing.enable('c1', 'u')
      await expect(sign(onlyUnusable.signing, OCTO)).rejects.toMatchObject({ code: 'not_configured' })

      const otherSquad = harness({ accounts: two })
      await otherSquad.signing.enable('c1', 'u')
      await otherSquad.signing.enable('c2', 'u')
      await expect(sign(otherSquad.signing, HUBOT, 's2')).rejects.toMatchObject({ code: 'not_configured' })
    })

    it('refuses an email two different attached accounts both claim', async () => {
      const { signing } = harness({
        accounts: two,
        profileEmails: { c1: 'shared@example.com', c2: 'shared@example.com' },
      })
      await signing.enable('c1', 'u')
      await signing.enable('c2', 'u')
      await expect(sign(signing, 'shared@example.com')).rejects.toMatchObject({ code: 'identity_mismatch' })
    })

    it('refuses without a connection, with signing off and for non-git payloads', async () => {
      await expect(sign(harness().signing, OCTO)).rejects.toMatchObject({ code: 'not_configured' })
      await expect(sign(harness({ accounts: [{}] }).signing, OCTO)).rejects.toMatchObject({ code: 'signing_off' })

      const on = harness({ accounts: [{}] })
      await on.signing.enable('c1', 'u')
      await expect(
        on.signing.sign({ squadId: 's1', agentId: 'a1', payload: Buffer.from('not a commit') })
      ).rejects.toMatchObject({ code: 'invalid_payload' })
    })
  })

  describe('summaries', () => {
    const leaks = (value: unknown) => /PRIVATE KEY|privateKey|ssh-ed25519|githubKeyId/.test(JSON.stringify(value))

    it('shows per connection whether it signs, as whom and for which committer emails', async () => {
      const { signing } = harness({ accounts: [{}], profileEmails: { c1: 'octo@example.com' } })
      expect(await signing.summary('c1')).toEqual({ state: 'off', login: 'octo', signsFor: [] })
      expect(await signing.summary('missing')).toBeUndefined()
      await signing.enable('c1', 'u')
      const on = await signing.summary('c1')
      expect(on).toEqual({
        state: 'on',
        login: 'octo',
        signsFor: ['7+octo@users.noreply.github.com', 'octo@example.com'],
        fingerprint: expect.stringMatching(/^SHA256:/),
      })
      expect(leaks(on)).toBe(false)
    })

    it('needs attention when signing is on but the connection may not sign or its key left GitHub', async () => {
      const unusable = harness({ accounts: [{ canSign: false }] })
      await unusable.signing.enable('c1', 'u')
      expect(await unusable.signing.summary('c1')).toMatchObject({ state: 'needs_attention', signsFor: [] })

      const removed = harness({ accounts: [{}], exists: false })
      await removed.signing.enable('c1', 'u')
      expect(await removed.signing.summary('c1')).toMatchObject({ state: 'on' })
      expect(await removed.signing.summary('c1', { checkGitHub: true })).toMatchObject({
        state: 'needs_attention',
        signsFor: [],
      })
    })

    it('shows per squad which attached accounts it signs as and which is the default', async () => {
      const { signing } = harness({
        accounts: [
          { login: 'octo', userId: 7 },
          { login: 'hubot', userId: 9 },
          { login: 'ghost', userId: 11, canSign: false },
          { login: 'idle', userId: 13 },
        ],
      })
      for (const id of ['c1', 'c2', 'c3']) await signing.enable(id, 'u')
      const summary = await signing.squadSummary('s1')
      expect(summary.defaultConnectionId).toBe('c1')
      expect(
        summary.accounts.map(({ connectionId, isDefault, login, state, signsFor }) => ({
          connectionId,
          isDefault,
          login,
          state,
          signsFor,
        }))
      ).toEqual([
        {
          connectionId: 'c1',
          isDefault: true,
          login: 'octo',
          state: 'on',
          signsFor: ['7+octo@users.noreply.github.com'],
        },
        {
          connectionId: 'c2',
          isDefault: false,
          login: 'hubot',
          state: 'on',
          signsFor: ['9+hubot@users.noreply.github.com'],
        },
        { connectionId: 'c3', isDefault: false, login: 'ghost', state: 'needs_attention', signsFor: [] },
        { connectionId: 'c4', isDefault: false, login: 'idle', state: 'off', signsFor: [] },
      ])
      expect(leaks(summary)).toBe(false)
      expect(await signing.squadSummary('s2')).toEqual({ defaultConnectionId: null, accounts: [] })
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
