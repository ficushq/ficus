import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { randomUUID } from 'crypto'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { inArray } from 'drizzle-orm'
import { db, integrationConnectionAssignments, integrationConnections, squads } from '../../../db'
import { useEnabledIntegrationFixtures } from '../../../test-utils/enabled-integrations'
import { getSecretStore } from '../../secrets'
import { githubCommitSigning, squadIntegrationRoutesService } from '../runtime'
import { githubSigningSecretKey } from './commit-signing-store'
import { generateSshSigningKey } from './ssh-signature'

/**
 * The signer as Core wires it, against the database and secret store. Every
 * account, key and squad here is a synthetic fixture; GitHub is never called.
 */
const TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const commitAs = (email: string) =>
  Buffer.from(`tree ${TREE}\nauthor A <${email}> 1 +0000\ncommitter A <${email}> 1 +0000\n\nmsg\n`)

const created = { connections: [] as string[], squads: [] as string[], secrets: [] as string[] }
const publicKeys = new Map<string, string>()

async function squad(githubIdentityEmail?: string): Promise<string> {
  const [row] = await db
    .insert(squads)
    .values({
      name: `signing-runtime-${randomUUID()}`,
      purpose: 'commit signing runtime fixture',
      ...(githubIdentityEmail
        ? { metadata: { githubIdentity: { gitUserName: 'Override', gitUserEmail: githubIdentityEmail } } }
        : {}),
    })
    .returning()
  created.squads.push(row!.id)
  return row!.id
}

/** A connected account with commit signing on, backed by a locally generated key. */
async function account(login: string, userId: number, options: { signing?: boolean } = {}): Promise<string> {
  const id = randomUUID()
  const revision = randomUUID()
  const credentialRef = `__integration-test:github:${id}`
  // Not a credential bundle: the token cannot be resolved, so no profile request can be made.
  await getSecretStore().set(credentialRef, 'bundle', 'test')
  created.secrets.push(credentialRef)
  await db.insert(integrationConnections).values({
    id,
    providerKey: 'github',
    adapterVersion: 1,
    displayName: `github-${login}`,
    configuration: { version: 1, userId, login },
    credentialRef,
    enabled: true,
    authState: 'authenticated',
    healthState: 'healthy',
    materialRevision: revision,
    validatedRevision: revision,
    validatedAt: new Date(),
    validationExpiresAt: new Date(Date.now() + 600_000),
  })
  created.connections.push(id)
  if (options.signing !== false) {
    const key = generateSshSigningKey(`fixture-${login}`)
    publicKeys.set(id, key.publicKey)
    created.secrets.push(githubSigningSecretKey(id))
    await getSecretStore().set(
      githubSigningSecretKey(id),
      JSON.stringify({
        version: 1,
        state: 'on',
        privateKey: key.privateKey,
        publicKey: key.publicKey,
        githubKeyId: userId,
        enabledAt: new Date().toISOString(),
        enabledBy: 'test',
      }),
      'test'
    )
  }
  return id
}

async function attach(squadId: string, connectionId: string, isDefault: boolean) {
  await db.insert(integrationConnectionAssignments).values({ squadId, providerKey: 'github', connectionId, isDefault })
}

function signedBy(connectionId: string, payload: Buffer, signature: string): boolean {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ficus-sign-')))
  try {
    writeFileSync(join(dir, 'allowed'), `signer ${publicKeys.get(connectionId)}\n`)
    writeFileSync(join(dir, 'sig'), signature)
    return (
      Bun.spawnSync(
        ['ssh-keygen', '-Y', 'verify', '-f', join(dir, 'allowed'), '-I', 'signer', '-n', 'git', '-s', join(dir, 'sig')],
        { stdin: payload, stdout: 'pipe', stderr: 'pipe' }
      ).exitCode === 0
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const sign = (squadId: string, email: string) =>
  githubCommitSigning.sign({ squadId, agentId: 'agent-fixture', payload: commitAs(email) })

const AGENT = '7001+fixture-agent@users.noreply.github.com'
const OWNER = '7002+fixture-owner@users.noreply.github.com'

describe('commit signing as Core wires it', () => {
  useEnabledIntegrationFixtures('github')
  let previousKey: string | undefined
  let originalFetch: typeof fetch
  let requests = 0

  beforeAll(async () => {
    previousKey = process.env.FICUS_ENCRYPTION_KEY
    process.env.FICUS_ENCRYPTION_KEY ??= '0'.repeat(64)
    await getSecretStore().initialize()
    originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      requests++
      throw new Error('commit signing fixtures must not reach the network')
    }) as unknown as typeof fetch
  })

  afterAll(async () => {
    globalThis.fetch = originalFetch
    if (created.connections.length) {
      await db
        .delete(integrationConnectionAssignments)
        .where(inArray(integrationConnectionAssignments.connectionId, created.connections))
      await db.delete(integrationConnections).where(inArray(integrationConnections.id, created.connections))
    }
    for (const key of created.secrets) await getSecretStore().delete(key)
    if (created.squads.length) await db.delete(squads).where(inArray(squads.id, created.squads))
    if (previousKey === undefined) delete process.env.FICUS_ENCRYPTION_KEY
    else process.env.FICUS_ENCRYPTION_KEY = previousKey
    await getSecretStore().initialize()
  })

  it('signs each commit with the attached account its committer email belongs to', async () => {
    const squadId = await squad()
    const [agent, owner] = [await account('fixture-agent', 7001), await account('fixture-owner', 7002)]
    await attach(squadId, agent, true)
    await attach(squadId, owner, false)

    const asAgent = await sign(squadId, AGENT)
    const asOwner = await sign(squadId, OWNER)
    expect(signedBy(agent, commitAs(AGENT), asAgent)).toBe(true)
    expect(signedBy(owner, commitAs(OWNER), asOwner)).toBe(true)
    expect(signedBy(agent, commitAs(OWNER), asOwner)).toBe(false)
    await expect(sign(squadId, 'someone@example.com')).rejects.toMatchObject({ code: 'identity_mismatch' })
  })

  it("a githubIdentity email of another account is never signed with the default account's key", async () => {
    // Default is the agent account; the squad's configured git identity is the owner's address.
    const owner = await account('fixture-owner', 7002)

    const notAttached = await squad(OWNER)
    await attach(notAttached, await account('fixture-agent', 7001), true)
    const refused = sign(notAttached, OWNER)
    await expect(refused).rejects.toMatchObject({ code: 'identity_mismatch' })
    await expect(refused).rejects.toThrow(`@fixture-agent (default): ${AGENT}`)

    const attached = await squad(OWNER)
    const agent = await account('fixture-agent', 7001)
    await attach(attached, agent, true)
    await attach(attached, owner, false)
    const signature = await sign(attached, OWNER)
    expect(signedBy(owner, commitAs(OWNER), signature)).toBe(true)
    expect(signedBy(agent, commitAs(OWNER), signature)).toBe(false)

    // An override that is nobody's GitHub address is refused as well.
    const unrelated = await squad('override@example.com')
    await attach(unrelated, await account('fixture-agent', 7001), true)
    await expect(sign(unrelated, 'override@example.com')).rejects.toMatchObject({ code: 'identity_mismatch' })
  })

  it('does not sign with unassigned, disabled, reconnect-required, signing-off or other-squad connections', async () => {
    const [mine, theirs] = [await squad(), await squad()]
    const agent = await account('fixture-agent', 7001)
    const owner = await account('fixture-owner', 7002)
    await attach(mine, agent, true)
    await attach(theirs, owner, true)
    // Attached only to the other squad.
    await expect(sign(mine, OWNER)).rejects.toMatchObject({ code: 'identity_mismatch' })
    expect(signedBy(owner, commitAs(OWNER), await sign(theirs, OWNER))).toBe(true)

    for (const change of [{ enabled: false }, { authState: 'reauthorization_required' as const }]) {
      const squadId = await squad()
      const unusable = await account('fixture-owner', 7002)
      await attach(squadId, await account('fixture-agent', 7001), true)
      await attach(squadId, unusable, false)
      await db
        .update(integrationConnections)
        .set(change)
        .where(inArray(integrationConnections.id, [unusable]))
      await expect(sign(squadId, OWNER)).rejects.toMatchObject({ code: 'identity_mismatch' })
    }

    const off = await squad()
    await attach(off, await account('fixture-agent', 7001), true)
    await attach(off, await account('fixture-owner', 7002, { signing: false }), false)
    await expect(sign(off, OWNER)).rejects.toMatchObject({ code: 'signing_off' })
  })

  it('the squad integration view shows who signs, and no key material', async () => {
    const squadId = await squad()
    const [agent, owner] = [
      await account('fixture-agent', 7001),
      await account('fixture-owner', 7002, { signing: false }),
    ]
    await attach(squadId, agent, true)
    await attach(squadId, owner, false)
    const selection = await squadIntegrationRoutesService.selection(squadId, 'github')
    expect(selection.commitSigning).toEqual({
      defaultConnectionId: agent,
      accounts: [
        {
          connectionId: agent,
          isDefault: true,
          login: 'fixture-agent',
          state: 'on',
          signsFor: [AGENT],
          fingerprint: expect.stringMatching(/^SHA256:/),
        },
        { connectionId: owner, isDefault: false, login: 'fixture-owner', state: 'off', signsFor: [] },
      ],
    })
    expect(JSON.stringify(selection)).not.toMatch(/PRIVATE KEY|privateKey|ssh-ed25519/)
    expect(requests).toBe(0)
  })
})
