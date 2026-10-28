/**
 * Per-agent secrets: isolation, revocation and lifecycle of the agent secrets
 * file. Synthetic keys and values only; nothing here touches a real secret.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { inArray } from 'drizzle-orm'
import { agentSecretExposures, agents, db, squads } from '../../db'
import { Agent } from '../../entities/Agent'
import { getSecretStore, resetSecretStore } from '../secrets'
import { getContentSafetyRegistry, resetContentSafetyRegistry } from '../security/content-safety-registry'
import { wrapToolWithOutputRedaction } from '../security/tool-output-redaction'
import { resolveSandboxAssets } from '../sandbox/asset-manifest'
import { agentSecretsHostPath } from '../sandbox/agent-secrets-file'
import { archiveAgentPrivateDir } from '../sandbox/private-archive'
import { getSquadWorkspacePath } from '../squad/workspace'
import { WORKSPACE_DOT_DIR } from '../workspace/dot-dir'
import {
  AgentSecretsError,
  agentSecretNamesForSandbox,
  agentSecretsUnsupportedReason,
  changeAgentExposedSecretKeys,
  getAgentExposedSecretKeys,
  getAgentSecretsStatus,
  materializeAgentSecretsFile,
  regenerateAgentSecretFilesForSecretKey,
  renderAgentSecretsFile,
} from './secrets'

const suffix = Math.random().toString(36).slice(2, 8).toUpperCase()
const KEY = `SYNTH_AGENT_SECRET_${suffix}`
const VALUE = `synthetic-agent-value-${crypto.randomUUID()}`
const noSync = async () => ({ pushed: false, reason: 'test' })

let home: string
let squadId: string
let otherSquadId: string
let agentA: string
let agentB: string
let subagentC: string
const originalHome = process.env.HOME_DIR
const originalRuntime = process.env.FICUS_SANDBOX_RUNTIME
const originalEncryptionKey = process.env.FICUS_ENCRYPTION_KEY

beforeAll(async () => {
  process.env.FICUS_ENCRYPTION_KEY = originalEncryptionKey ?? '0'.repeat(64)
  resetSecretStore()
  resetContentSafetyRegistry()
  await getSecretStore().initialize()
  await getSecretStore().set(KEY, VALUE, 'test')
})

afterAll(async () => {
  await getSecretStore()
    .delete(KEY)
    .catch(() => {})
  if (originalEncryptionKey === undefined) delete process.env.FICUS_ENCRYPTION_KEY
  else process.env.FICUS_ENCRYPTION_KEY = originalEncryptionKey
  resetContentSafetyRegistry()
  resetSecretStore()
})

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'agent-secrets-'))
  process.env.HOME_DIR = home
  process.env.FICUS_SANDBOX_RUNTIME = 'docker'
  ;[{ id: squadId }, { id: otherSquadId }] = await db
    .insert(squads)
    .values([
      { name: `agent-secrets ${suffix}`, purpose: 'test' },
      { name: `agent-secrets other ${suffix}`, purpose: 'test' },
    ])
    .returning({ id: squads.id })
  ;[{ id: agentA }, { id: agentB }] = await db
    .insert(agents)
    .values([
      { agentTypeId: 'engineer', squadId },
      { agentTypeId: 'engineer', squadId },
    ])
    .returning({ id: agents.id })
  ;[{ id: subagentC }] = await db
    .insert(agents)
    .values({ agentTypeId: 'subagent', squadId, parentAgentId: agentA })
    .returning({ id: agents.id })
})

afterEach(async () => {
  await db.delete(agents).where(inArray(agents.id, [subagentC, agentA, agentB]))
  await db.delete(squads).where(inArray(squads.id, [squadId, otherSquadId]))
  rmSync(home, { recursive: true, force: true })
  if (originalHome === undefined) delete process.env.HOME_DIR
  else process.env.HOME_DIR = originalHome
  if (originalRuntime === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
  else process.env.FICUS_SANDBOX_RUNTIME = originalRuntime
})

const fileOf = (agentId: string) => agentSecretsHostPath(`agent_${agentId}`)

describe('exposing a Secret Store key to one agent', () => {
  it('writes the value only into that agent’s own 0600 secrets file', async () => {
    const result = await changeAgentExposedSecretKeys(agentA, { mode: 'add', keys: [KEY] }, { syncSandbox: noSync })

    expect(result.exposedSecretKeys).toEqual([KEY])
    expect(JSON.stringify(result)).not.toContain(VALUE)
    const content = readFileSync(fileOf(agentA), 'utf8')
    expect(content).toContain(`export ${KEY}='${VALUE}'`)
    expect(statSync(fileOf(agentA)).mode & 0o777).toBe(0o600)

    // Another agent in the same squad gets nothing, and neither does the shared squad workspace.
    await materializeAgentSecretsFile(`agent_${agentB}`)
    expect(existsSync(fileOf(agentB))).toBe(false)
    const squadDotDir = join(getSquadWorkspacePath(squadId), WORKSPACE_DOT_DIR)
    for (const name of existsSync(squadDotDir) ? readdirSync(squadDotDir) : []) {
      expect(readFileSync(join(squadDotDir, name), 'utf8')).not.toContain(VALUE)
    }
  })

  it('delivers the file only to the agent’s own box, never to a teammate or the squad box', async () => {
    await changeAgentExposedSecretKeys(agentA, { mode: 'add', keys: [KEY] }, { syncSandbox: noSync })

    const filesFor = async (sandboxId: string, role: 'agent' | 'squad') => {
      const resolved = await resolveSandboxAssets({ sandboxId, squadId, role })
      const asset = resolved.find((r) => r.asset.name === 'agent-secrets')
      return asset ? (await asset.source.files()).map((f) => Buffer.from(f.bytes).toString('utf8')) : null
    }
    expect((await filesFor(`agent_${agentA}`, 'agent'))?.join('')).toContain(VALUE)
    expect(await filesFor(`agent_${agentB}`, 'agent')).toEqual([])
    expect(await filesFor(`squad_${squadId}`, 'squad')).toBeNull()
  })

  it('lists names only and reports the sandbox path, never a value', async () => {
    await changeAgentExposedSecretKeys(agentA, { mode: 'add', keys: [KEY] }, { syncSandbox: noSync })
    const status = await getAgentSecretsStatus(agentA)
    expect(status.exposedSecretKeys).toEqual([KEY])
    expect(status.unsupportedReason).toBeNull()
    expect(status.secretsFilePath).toBe('/private/.ficus/agent-secrets.env')
    expect(JSON.stringify(status)).not.toContain(VALUE)
  })

  it('removes the file when the key is unexposed', async () => {
    await changeAgentExposedSecretKeys(agentA, { mode: 'add', keys: [KEY] }, { syncSandbox: noSync })
    const result = await changeAgentExposedSecretKeys(agentA, { mode: 'remove', keys: [KEY] }, { syncSandbox: noSync })
    expect(result.exposedSecretKeys).toEqual([])
    expect(existsSync(fileOf(agentA))).toBe(false)
    expect(await getAgentExposedSecretKeys(agentA)).toEqual([])
  })

  it('refuses to add keys the caller cannot read, but never blocks removing them', async () => {
    const cannotRead = { syncSandbox: noSync, mayReadSecret: () => false }
    await expect(changeAgentExposedSecretKeys(agentA, { mode: 'add', keys: [KEY] }, cannotRead)).rejects.toMatchObject({
      status: 403,
    })
    expect(existsSync(fileOf(agentA))).toBe(false)

    await changeAgentExposedSecretKeys(agentA, { mode: 'add', keys: [KEY] }, { syncSandbox: noSync })
    // Keeping an existing key in a replace is not an addition.
    await changeAgentExposedSecretKeys(agentA, { mode: 'replace', keys: [KEY] }, cannotRead)
    const removed = await changeAgentExposedSecretKeys(agentA, { mode: 'remove', keys: [KEY] }, cannotRead)
    expect(removed.exposedSecretKeys).toEqual([])
    expect(existsSync(fileOf(agentA))).toBe(false)
  })

  it('refuses platform-managed, GitHub and Ficus identity names', async () => {
    for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'FICUS_TOKEN', '__internal']) {
      await expect(
        changeAgentExposedSecretKeys(agentA, { mode: 'add', keys: [key] }, { syncSandbox: noSync })
      ).rejects.toBeInstanceOf(AgentSecretsError)
    }
    expect(await getAgentExposedSecretKeys(agentA)).toEqual([])
  })

  it('rewrites the file with the new value when the Secret Store value changes', async () => {
    await changeAgentExposedSecretKeys(agentA, { mode: 'add', keys: [KEY] }, { syncSandbox: noSync })
    const rotated = `rotated-synthetic-value-${crypto.randomUUID()}`
    await getSecretStore().set(KEY, rotated, 'test')
    try {
      await regenerateAgentSecretFilesForSecretKey(KEY)
      const content = readFileSync(fileOf(agentA), 'utf8')
      expect(content).toContain(rotated)
      expect(content).not.toContain(VALUE)
    } finally {
      await getSecretStore().set(KEY, VALUE, 'test')
    }
  })

  it('never writes through a symlinked settings dir in the private dir', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'agent-secrets-elsewhere-'))
    try {
      const privateRoot = join(home, 'private', `agent_${agentA}`)
      mkdirSync(privateRoot, { recursive: true })
      symlinkSync(elsewhere, join(privateRoot, WORKSPACE_DOT_DIR))
      await expect(
        changeAgentExposedSecretKeys(agentA, { mode: 'add', keys: [KEY] }, { syncSandbox: noSync })
      ).rejects.toThrow()
      expect(readdirSync(elsewhere)).toEqual([])
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })
})

describe('who can hold per-agent secrets', () => {
  it('subagents inherit their parent’s secrets through the shared sandbox, and cannot be targeted', async () => {
    await changeAgentExposedSecretKeys(agentA, { mode: 'add', keys: [KEY] }, { syncSandbox: noSync })

    const subagent = await Agent.mustFind(subagentC)
    const sandboxId = await subagent.getSandboxId()
    expect(sandboxId).toBe(`agent_${agentA}`)
    expect(await agentSecretNamesForSandbox(sandboxId)).toEqual([KEY])

    const refused = changeAgentExposedSecretKeys(subagentC, { mode: 'add', keys: [KEY] }, { syncSandbox: noSync })
    await expect(refused).rejects.toMatchObject({ status: 400 })
    await expect(refused).rejects.toThrow(/parent agent/)
  })

  it('refuses shared-sandbox agents and the host runtime', () => {
    const base = { squadId, parentAgentId: null, status: 'idle' as const }
    expect(agentSecretsUnsupportedReason({ ...base, agentTypeId: 'engineer' }, false)).toBeNull()
    expect(agentSecretsUnsupportedReason({ ...base, agentTypeId: 'consultant' }, false)).toMatch(/shared/)
    expect(agentSecretsUnsupportedReason({ ...base, agentTypeId: 'system-manager' }, false)).toMatch(/shared/)
    expect(agentSecretsUnsupportedReason({ ...base, agentTypeId: 'engineer' }, true)).toMatch(/host runtime/)
    expect(agentSecretsUnsupportedReason({ ...base, agentTypeId: 'engineer', status: 'terminated' }, false)).toMatch(
      /terminated/
    )
  })

  it('refuses exposure on the host runtime and writes nothing', async () => {
    process.env.FICUS_SANDBOX_RUNTIME = 'host'
    await expect(
      changeAgentExposedSecretKeys(agentA, { mode: 'add', keys: [KEY] }, { syncSandbox: noSync })
    ).rejects.toThrow(/host runtime/)
    expect(existsSync(fileOf(agentA))).toBe(false)
  })

  it('ignores an exposure recorded for a different squad', async () => {
    await db.insert(agentSecretExposures).values({ agentId: agentA, squadId: otherSquadId, secretKey: KEY })
    expect(await getAgentExposedSecretKeys(agentA)).toEqual([])
    expect(await materializeAgentSecretsFile(`agent_${agentA}`)).toEqual([])
    expect(existsSync(fileOf(agentA))).toBe(false)
  })

  it('removes the file while the agent is dormant and restores it when it is live again', async () => {
    await changeAgentExposedSecretKeys(agentA, { mode: 'add', keys: [KEY] }, { syncSandbox: noSync })
    await db
      .update(agents)
      .set({ status: 'dormant' })
      .where(inArray(agents.id, [agentA]))
    await materializeAgentSecretsFile(`agent_${agentA}`)
    expect(existsSync(fileOf(agentA))).toBe(false)

    await db
      .update(agents)
      .set({ status: 'idle' })
      .where(inArray(agents.id, [agentA]))
    await materializeAgentSecretsFile(`agent_${agentA}`)
    expect(readFileSync(fileOf(agentA), 'utf8')).toContain(VALUE)
  })

  it('never archives the secrets file with a terminated agent’s private dir', async () => {
    await changeAgentExposedSecretKeys(agentA, { mode: 'add', keys: [KEY] }, { syncSandbox: noSync })
    const archived = archiveAgentPrivateDir(`agent_${agentA}`, new Date())
    expect(archived).not.toBeNull()
    expect(existsSync(join(archived!, WORKSPACE_DOT_DIR, 'agent-secrets.env'))).toBe(false)
  })
})

describe('redaction', () => {
  it('redacts a per-agent secret the agent echoes in tool output', async () => {
    await changeAgentExposedSecretKeys(agentA, { mode: 'add', keys: [KEY] }, { syncSandbox: noSync })
    const echoTool = {
      name: 'bash',
      label: 'bash',
      description: 'echo',
      parameters: {},
      execute: async () => ({ content: [{ type: 'text', text: `token is ${VALUE}\n` }], details: {} }),
    }
    const wrapped = wrapToolWithOutputRedaction(echoTool as never, getContentSafetyRegistry())
    const result = (await (wrapped as unknown as typeof echoTool).execute()) as {
      content: Array<{ text: string }>
    }
    expect(result.content[0]!.text).not.toContain(VALUE)
    expect(result.content[0]!.text).toContain(`[REDACTED_SECRET_ENV:${KEY}]`)
  })
})

describe('renderAgentSecretsFile', () => {
  it('never renders any of the six retired deployment names, even with an injected legacy getter', () => {
    const providers = ['CLOUDFLARE', 'DIGITALOCEAN', 'NETLIFY', 'RAILWAY', 'SUPABASE', 'VERCEL']
    expect(
      renderAgentSecretsFile(
        providers.map((provider) => `DEPLOY_${provider}_TOKEN`),
        () => 'synthetic-retired'
      )
    ).toBeNull()
  })
  it('quotes values for the shell and skips unset keys', () => {
    const content = renderAgentSecretsFile(['B_KEY', 'A_KEY', 'UNSET_KEY'], (key) =>
      key === 'UNSET_KEY' ? undefined : key === 'A_KEY' ? "it's" : 'plain'
    )
    expect(content).toContain(`export A_KEY='it'"'"'s'`)
    expect(content).toContain(`export B_KEY='plain'`)
    expect(content).not.toContain('UNSET_KEY')
    expect(renderAgentSecretsFile(['UNSET_KEY'], () => undefined)).toBeNull()
  })
})
