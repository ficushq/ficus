import type {
  GitHubCommitSigningErrorCode,
  GitHubCommitSigningStatus,
  GitHubCommitSigningSummary,
  GitHubSquadCommitSigning,
} from '@ficus/shared'
import { createLogger } from '../../../lib/infra/logger'
import { generateSshSigningKey, signSshSig, sshKeyFingerprint } from './ssh-signature'
import { parseGitSigningPayload } from './signing-payload'
import { gitHubNoreplyEmail } from './author-defaults'
import {
  githubSigningSecretKey,
  parseGitHubSigningRecord,
  type GitHubSigningAccount,
  type GitHubSigningRecord,
} from './commit-signing-store'

const log = createLogger('github-commit-signing')

export class GitHubSigningError extends Error {
  constructor(
    readonly code: GitHubCommitSigningErrorCode,
    message: string
  ) {
    super(message)
  }
}

/** Why Core refused to sign an agent's commit; surfaced verbatim by the `ficus` signing program. */
export class GitHubSignRefused extends Error {
  constructor(
    readonly code: 'not_configured' | 'signing_off' | 'invalid_payload' | 'identity_mismatch',
    message: string
  ) {
    super(message)
  }
}

/**
 * What the signer decided for a commit or tag it did not refuse. `signed: false`
 * is a deliberate outcome, not an error: the committer's own account is attached
 * to the squad with commit signing off, so the object is created without a signature.
 */
export type GitHubSignResult =
  { signed: true; signature: string } | { signed: false; reason: 'signing_off'; login: string; message: string }

export interface GitHubAccount {
  accessToken: string
  login: string
  userId: number
}

/** The three `/user/ssh_signing_keys` calls, behind a seam for tests. */
export interface GitHubSigningKeysApi {
  create(accessToken: string, input: { title: string; key: string }): Promise<{ id: number }>
  /** True when present, false when GitHub reports it gone. Throws when GitHub cannot be asked. */
  exists(accessToken: string, id: number): Promise<boolean>
  /** Resolves when deleted or already gone. */
  remove(accessToken: string, id: number): Promise<void>
}

export interface GitHubCommitSigningDependencies {
  secrets: {
    get(key: string): string | undefined
    refreshKey(key: string): Promise<void>
    set(key: string, value: string, actor: string): Promise<void>
    delete(key: string): Promise<void>
  }
  keys: GitHubSigningKeysApi
  /** A usable account for the connection, or undefined when its credential cannot be used right now. */
  account(connectionId: string): Promise<GitHubAccount | undefined>
  /** Enabled, authenticated GitHub connections this Ficus user connected or last reconnected. */
  connectionIdsFor(userId: string): Promise<string[]>
  /** Every GitHub connection assigned to the squad, default first, each saying whether it may sign. */
  squadAccounts(squadId: string): Promise<GitHubSigningAccount[]>
  /** One GitHub connection outside a squad, or undefined when it does not exist. */
  connectionAccount(connectionId: string): Promise<GitHubSigningAccount | undefined>
  /**
   * Committer emails that belong to the account behind the connection: its
   * noreply address and its public profile email. Never an email configured in
   * Ficus (squad git identity, secrets): those say nothing about who owns the key.
   */
  accountEmails(account: GitHubSigningAccount, squadId?: string): Promise<string[]>
  /** Re-render env files of squads using the connection so their `git` picks up the change. */
  reproject(connectionId: string): Promise<void>
  keyTitle(): string
  now(): Date
}

export class GitHubCommitSigning {
  constructor(private readonly deps: GitHubCommitSigningDependencies) {}

  async #record(connectionId: string): Promise<GitHubSigningRecord | undefined> {
    const key = githubSigningSecretKey(connectionId)
    await this.deps.secrets.refreshKey(key)
    return parseGitHubSigningRecord(this.deps.secrets.get(key))
  }

  async status(connectionId: string): Promise<GitHubCommitSigningStatus> {
    const record = await this.#record(connectionId)
    if (record?.state !== 'on') return { state: 'off' }
    let registeredOnGitHub: boolean | null = null
    try {
      const account = await this.deps.account(connectionId)
      if (account) registeredOnGitHub = await this.deps.keys.exists(account.accessToken, record.githubKeyId)
    } catch {
      registeredOnGitHub = null
    }
    return {
      state: 'on',
      fingerprint: sshKeyFingerprint(record.publicKey),
      enabledAt: record.enabledAt,
      registeredOnGitHub,
    }
  }

  /**
   * Generate a key, register it on the connected GitHub account and store it.
   * Idempotent while the registered key is intact; a key someone deleted on
   * GitHub is replaced.
   */
  async enable(connectionId: string, actor: string): Promise<GitHubCommitSigningStatus> {
    const account = await this.deps.account(connectionId)
    if (!account)
      throw new GitHubSigningError(
        'connection_unusable',
        'This GitHub account needs attention before Ficus can use it. Reconnect it, then turn signing on.'
      )
    const existing = await this.#record(connectionId)
    if (existing?.state === 'on') {
      const present = await this.deps.keys.exists(account.accessToken, existing.githubKeyId).catch(() => null)
      if (present !== false) return this.status(connectionId)
    }

    const key = generateSshSigningKey(`ficus-commit-signing-${account.login}`)
    const created = await this.deps.keys.create(account.accessToken, {
      title: this.deps.keyTitle(),
      key: key.publicKey,
    })
    const record: GitHubSigningRecord = {
      version: 1,
      state: 'on',
      privateKey: key.privateKey,
      publicKey: key.publicKey,
      githubKeyId: created.id,
      enabledAt: this.deps.now().toISOString(),
      enabledBy: actor,
    }
    try {
      await this.deps.secrets.set(githubSigningSecretKey(connectionId), JSON.stringify(record), actor)
    } catch (error) {
      // Never leave a registered key whose private half Ficus failed to keep.
      await this.deps.keys.remove(account.accessToken, created.id).catch(() => {})
      throw error
    }
    log.info(`Commit signing on for GitHub connection ${connectionId} (${account.login}) by ${actor}`)
    await this.deps.reproject(connectionId)
    return this.status(connectionId)
  }

  /** Remove the key from GitHub (best-effort) and remember that signing is off. */
  async disable(connectionId: string, actor: string): Promise<GitHubCommitSigningStatus> {
    const record = await this.#record(connectionId)
    if (record?.state === 'on') await this.#unregister(connectionId, record)
    const off: GitHubSigningRecord = {
      version: 1,
      state: 'off',
      updatedAt: this.deps.now().toISOString(),
      updatedBy: actor,
    }
    await this.deps.secrets.set(githubSigningSecretKey(connectionId), JSON.stringify(off), actor)
    log.info(`Commit signing off for GitHub connection ${connectionId} by ${actor}`)
    await this.deps.reproject(connectionId)
    return { state: 'off' }
  }

  /**
   * Connect-time setup: turn signing on for the connecting person's usable
   * connections that never had a signing decision. Only their own: a key is
   * registered on the GitHub account behind the connection. Best-effort per
   * connection; failures leave the card's "Turn on" control in place.
   */
  async enableUndecided(userId: string): Promise<void> {
    for (const connectionId of await this.deps.connectionIdsFor(userId)) {
      if (await this.#record(connectionId)) continue
      try {
        await this.enable(connectionId, `user:${userId}`)
      } catch (error) {
        log.warn(`Commit signing setup skipped for GitHub connection ${connectionId}: ${(error as Error).message}`)
      }
    }
  }

  /**
   * Capture what removal must clean up while the connection and its token
   * still exist; the returned step runs only after the removal commits.
   */
  async prepareRemoval(
    connectionId: string,
    accessToken: string | undefined
  ): Promise<(() => Promise<void>) | undefined> {
    const record = await this.#record(connectionId)
    if (!record) return undefined
    // Runs after the connection is gone, so it must never throw: a failure only leaves a log line.
    return async () => {
      await this.deps.secrets.delete(githubSigningSecretKey(connectionId)).catch((error: Error) => {
        log.warn(`Could not delete the signing key record of removed connection ${connectionId}: ${error.message}`)
      })
      if (record.state === 'on' && accessToken) {
        await this.deps.keys.remove(accessToken, record.githubKeyId).catch((error: Error) => {
          // The private half is gone, so the leftover public key can sign nothing.
          log.warn(`Could not remove signing key ${record.githubKeyId} from GitHub: ${error.message}`)
        })
      }
    }
  }

  /**
   * Sign a git commit or tag for an agent in the squad, or say that it stays unsigned.
   *
   * The outcome is decided by the object's committer (or tagger) email and
   * nothing else. Ownership of that email is settled first, across EVERY
   * account attached to the squad whatever its signing state:
   * - no attached account owns it, or two different accounts claim it: refused;
   * - its account has signing on and may sign: signed with that account's key;
   * - its account has signing on but may not sign right now: refused;
   * - its account has signing off (or never set up): left unsigned, as the
   *   account's owner chose. Nothing is signed with any key.
   *
   * A caller cannot name a connection, so it cannot get one account's signature
   * over content committed as another, and no other account's key is ever a fallback.
   */
  async sign(input: { squadId: string; agentId: string; payload: Buffer }): Promise<GitHubSignResult> {
    const attached = await this.deps.squadAccounts(input.squadId)
    if (!attached.some((account) => account.canSign))
      throw new GitHubSignRefused('not_configured', 'This squad has no usable GitHub account to sign commits with.')
    const candidates = await Promise.all(
      attached.map(async (account) => {
        const record = await this.#record(account.connectionId)
        return { account, record: record?.state === 'on' ? record : undefined }
      })
    )
    const signs = (candidate: (typeof candidates)[number]) => !!candidate.record && candidate.account.canSign
    if (!candidates.some(signs))
      throw new GitHubSignRefused(
        'signing_off',
        'Commit signing is off for this squad’s GitHub account. Turn it on in Settings → Integrations → GitHub.'
      )
    let parsed: ReturnType<typeof parseGitSigningPayload>
    try {
      parsed = parseGitSigningPayload(input.payload)
    } catch (error) {
      throw new GitHubSignRefused(
        'invalid_payload',
        `Ficus signs only git commits and tags: ${(error as Error).message}`
      )
    }
    const committer = parsed.signerEmail.slice(0, 254)
    const action = parsed.kind === 'commit' ? 'committed' : 'tagged'

    // A noreply address embeds the account id, so it names one account and needs no lookup.
    // Only when it names none are the public profile emails read, for every attached account.
    const noreply = (account: GitHubSigningAccount) => [gitHubNoreplyEmail(account).toLowerCase()]
    let emails = new Map<string, string[]>(attached.map((account) => [account.connectionId, noreply(account)]))
    const ownersOf = () =>
      candidates.filter(({ account }) => (emails.get(account.connectionId) ?? []).includes(parsed.signerEmail))
    let owners = ownersOf()
    if (owners.length === 0) {
      emails = new Map(
        await Promise.all(
          attached.map(
            async (account) =>
              [
                account.connectionId,
                (await this.deps.accountEmails(account, input.squadId)).map((email) => email.toLowerCase()),
              ] as const
          )
        )
      )
      owners = ownersOf()
    }
    const signable = () =>
      candidates
        .filter(signs)
        .map(
          ({ account }) =>
            `@${account.login}${account.isDefault ? ' (default)' : ''}: ${(emails.get(account.connectionId) ?? []).join(', ')}`
        )
        .join('; ')

    if (owners.length === 0)
      throw new GitHubSignRefused(
        'identity_mismatch',
        `Not signed: this ${parsed.kind} is ${action} as ${committer}, which is not an email of a GitHub account attached to this squad. ` +
          `It can sign as ${signable()}. ` +
          `Use one of those as the committer email (for example GIT_COMMITTER_EMAIL), or attach the GitHub account that owns ${committer} to this squad.`
      )
    // One email can vouch for one GitHub account only; two connections of the same account are equivalent.
    // Checked before anything else so the signing state of a claimant never decides whose email it is.
    const logins = [...new Map(owners.map(({ account }) => [account.userId, account.login])).values()]
    if (logins.length > 1)
      throw new GitHubSignRefused(
        'identity_mismatch',
        `Not signed: this ${parsed.kind} is ${action} as ${committer}, which ${logins.map((login) => `@${login}`).join(' and ')} both list as theirs, so Ficus cannot tell whose it is. ` +
          `Use an account’s users.noreply.github.com address as the committer email instead. This squad can sign as ${signable()}.`
      )

    const signer = owners.find(signs)
    if (signer?.record) {
      const signature = signSshSig(signer.record.privateKey, input.payload, 'git')
      log.info(
        `Signed git ${parsed.kind} for agent ${input.agentId} in squad ${input.squadId} with connection ${signer.account.connectionId} (${signer.account.login})`
      )
      return { signed: true, signature }
    }
    const login = owners[0]!.account.login
    if (owners.some((owner) => owner.record))
      throw new GitHubSignRefused(
        'identity_mismatch',
        `Not signed: this ${parsed.kind} is ${action} as ${committer}, and commit signing is on for @${login} but that GitHub account needs attention before Ficus can use it. ` +
          `Reconnect or enable it in Settings → Integrations → GitHub. Meanwhile this squad can sign as ${signable()}.`
      )
    log.info(
      `Left git ${parsed.kind} unsigned for agent ${input.agentId} in squad ${input.squadId}: signing is off for ${login}`
    )
    return {
      signed: false,
      reason: 'signing_off',
      login,
      message: `Not signed: commit signing is off for @${login}, the GitHub account ${committer} belongs to. Turn it on in Settings → Integrations → GitHub to have these ${parsed.kind}s signed.`,
    }
  }

  /**
   * Signing state of one connection for `ficus integration list/get`. With
   * `checkGitHub` it also asks GitHub whether the key is still registered (one
   * request, so `get` does and `list` does not); a removed key needs attention.
   */
  async summary(
    connectionId: string,
    options: { checkGitHub?: boolean } = {}
  ): Promise<GitHubCommitSigningSummary | undefined> {
    const account = await this.deps.connectionAccount(connectionId)
    if (!account) return undefined
    const record = await this.#record(connectionId)
    if (record?.state !== 'on') return { state: 'off', login: account.login, signsFor: [] }
    const fingerprint = sshKeyFingerprint(record.publicKey)
    const keyRemoved =
      account.canSign && options.checkGitHub && (await this.status(connectionId)).registeredOnGitHub === false
    if (!account.canSign || keyRemoved)
      return { state: 'needs_attention', login: account.login, signsFor: [], fingerprint }
    return { state: 'on', login: account.login, signsFor: await this.deps.accountEmails(account), fingerprint }
  }

  /**
   * Which attached accounts sign a squad's commits. Reads only Ficus's own
   * state (no GitHub key check), so a key someone removed on GitHub still shows
   * as on here; the per-connection summary reports that.
   */
  async squadSummary(squadId: string): Promise<GitHubSquadCommitSigning> {
    const accounts = await this.deps.squadAccounts(squadId)
    return {
      defaultConnectionId: accounts.find((account) => account.isDefault)?.connectionId ?? null,
      accounts: await Promise.all(
        accounts.map(async (account) => {
          const record = await this.#record(account.connectionId)
          const identity = { connectionId: account.connectionId, isDefault: account.isDefault, login: account.login }
          if (record?.state !== 'on') return { ...identity, state: 'off' as const, signsFor: [] }
          const fingerprint = sshKeyFingerprint(record.publicKey)
          if (!account.canSign) return { ...identity, state: 'needs_attention' as const, signsFor: [], fingerprint }
          return {
            ...identity,
            state: 'on' as const,
            signsFor: await this.deps.accountEmails(account, squadId),
            fingerprint,
          }
        })
      ),
    }
  }

  async #unregister(connectionId: string, record: Extract<GitHubSigningRecord, { state: 'on' }>): Promise<void> {
    try {
      const account = await this.deps.account(connectionId)
      if (account) await this.deps.keys.remove(account.accessToken, record.githubKeyId)
    } catch (error) {
      log.warn(`Could not remove signing key ${record.githubKeyId} from GitHub: ${(error as Error).message}`)
    }
  }
}

/** `api.github.com/user/ssh_signing_keys`; needs the App's "SSH signing keys" account permission. */
export function githubSigningKeysApi(
  fetcher: (input: string, init?: RequestInit) => Promise<Response> = fetch
): GitHubSigningKeysApi {
  async function call(accessToken: string, method: string, path: string, body?: unknown): Promise<Response> {
    let response: Response
    try {
      response = await fetcher(`https://api.github.com${path}`, {
        method,
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15_000),
        redirect: 'error',
      })
    } catch {
      throw new GitHubSigningError('github_unavailable', 'GitHub could not be reached. Try again in a moment.')
    }
    return response
  }
  return {
    async create(accessToken, input) {
      const response = await call(accessToken, 'POST', '/user/ssh_signing_keys', input)
      if (response.status === 201) {
        const json = (await response.json()) as { id?: unknown }
        if (typeof json.id === 'number' && Number.isInteger(json.id)) return { id: json.id }
        throw new GitHubSigningError('github_unavailable', 'GitHub returned an unexpected response.')
      }
      await response.body?.cancel()
      // An App without the account permission gets 403 ("Resource not accessible by integration") or 404.
      if (response.status === 403 || response.status === 404)
        throw new GitHubSigningError(
          'permission_missing',
          'Ficus’s GitHub App needs the “SSH signing keys” account permission. Reconnect this account and approve the updated permissions on GitHub, then turn signing on.'
        )
      if (response.status === 422)
        throw new GitHubSigningError('key_rejected', 'GitHub rejected the signing key. Try turning signing on again.')
      throw new GitHubSigningError('github_unavailable', `GitHub returned ${response.status}. Try again in a moment.`)
    },
    async exists(accessToken, id) {
      const response = await call(accessToken, 'GET', `/user/ssh_signing_keys/${id}`)
      await response.body?.cancel()
      if (response.ok) return true
      if (response.status === 404) return false
      throw new GitHubSigningError('github_unavailable', `GitHub returned ${response.status}.`)
    },
    async remove(accessToken, id) {
      const response = await call(accessToken, 'DELETE', `/user/ssh_signing_keys/${id}`)
      await response.body?.cancel()
      if (response.status === 204 || response.status === 404) return
      throw new GitHubSigningError('github_unavailable', `GitHub returned ${response.status}.`)
    },
  }
}
