import { expect, test } from 'bun:test'
import { firstPartyIntegrationPlugin, firstPartyIntegrationPlugins } from '../first-party-plugins'
import { projectIntegrationAssignments } from '../projection/projector'

const providers = {
  cloudflare: ['wrangler', 'CLOUDFLARE_API_TOKEN'],
  digitalocean: ['doctl', 'DIGITALOCEAN_ACCESS_TOKEN'],
  netlify: ['netlify', 'NETLIFY_AUTH_TOKEN'],
  railway: ['railway', 'RAILWAY_API_TOKEN'],
  supabase: ['supabase', 'SUPABASE_ACCESS_TOKEN'],
  vercel: ['vercel', 'VERCEL_TOKEN'],
}

for (const [key, [binary, variable]] of Object.entries(providers)) {
  test(`${key} is a manual assignable exec plugin with pinned CLI and deploy skill`, () => {
    const plugin = firstPartyIntegrationPlugin(key)
    expect(plugin).toBeDefined()
    if (!plugin) return
    expect(plugin.presentation).toMatchObject({ connectionMode: 'credential', assignable: true })
    expect(plugin.authorization.kind).toBe('manual')
    expect(plugin.execution?.binaries).toEqual([binary])
    const configuration = plugin.connection.parseConfiguration({ version: 1 })
    expect(plugin.execution?.environment[variable!]!({ credential: 'synthetic-command-token', configuration })).toBe(
      'synthetic-command-token'
    )
    expect(plugin.sandbox.skills).toEqual([`deploy-${key}`])
    expect(plugin.sandbox.setupSteps).toHaveLength(1)
    expect(plugin.sandbox.setupSteps[0]!.id).toMatch(/@\d+\.\d+\.\d+$/)
    expect(plugin.sandbox.setupSteps[0]!.script).toMatch(/sha512|sha256/)
    expect(plugin.sandbox.setupSteps[0]!.script).not.toContain('@latest')
    expect(plugin.sandbox.readiness[0]?.command).toBe(binary === 'doctl' ? 'doctl version' : `${binary} --version`)
    expect(plugin.sandbox.protectedBindings).toEqual([])
    expect(() => plugin.connection.parseConfiguration({ version: 1, token: 'synthetic' })).toThrow()
    expect(() => plugin.connection.credential.parse('   ')).toThrow()
    expect(() => plugin.connection.credential.parse('token\nsecond-line')).toThrow()
    const projection = projectIntegrationAssignments([{ plugin, connection: { id: key, configuration } } as any])
    expect(JSON.stringify(projection.publicDeclaration)).not.toContain('synthetic-command-token')
  })
}

test('Cloudflare account ID is nonsecret connection configuration delivered only through exec', () => {
  const plugin = firstPartyIntegrationPlugin('cloudflare')
  expect(plugin).toBeDefined()
  if (!plugin) return
  const configuration = plugin.connection.parseConfiguration({ version: 1, accountId: 'account-123' })
  expect(plugin.connection.safeConfiguration(configuration)).toEqual(configuration)
  expect(plugin.execution?.environment.CLOUDFLARE_ACCOUNT_ID?.({ configuration, credential: 'synthetic' })).toBe(
    'account-123'
  )
  expect(plugin.sandbox.protectedBindings).toEqual([])
})

test('channel and nonexecution plugins never declare exec', () => {
  for (const key of ['discord', 'slack', 'telegram', 'bigbrain'])
    expect(firstPartyIntegrationPlugin(key)?.execution).toBeUndefined()
  expect(
    firstPartyIntegrationPlugins
      .filter((p) => p.execution)
      .map((p) => p.key)
      .sort()
  ).toEqual(['github', 'linear', 'notion', ...Object.keys(providers)].sort())
})

test('attached deploy skills use assigned exec credentials rather than obsolete exposure or manual CLI installation', async () => {
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  for (const key of Object.keys(providers)) {
    const skill = readFileSync(
      join(import.meta.dir, '../../../../../../config/skills', `deploy-${key}`, 'SKILL.md'),
      'utf8'
    )
    expect(skill).not.toContain('DEPLOY_')
    expect(skill).not.toContain('expose-secrets')
    expect(skill).not.toContain('ficus secret')
    expect(skill).toContain(`ficus integration exec ${key} -- npm run deploy`)
    expect(skill).toContain('assign')
  }
})
