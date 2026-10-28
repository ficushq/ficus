import { expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const read = (path: string) => readFileSync(join(root, path), 'utf8')
function activeFiles(directory: string): string[] {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`
    return entry.isDirectory() ? activeFiles(path) : /\.(md|yaml)$/.test(path) ? [path] : []
  })
}

test('active skills and agent prompts never teach retired credential delivery or operator-store commands', () => {
  const forbidden = /secret store|ficus secret\b|(?:expose|unexpose)-(?:secrets|global)|agent-secrets\.env/i
  const violations = [
    ...activeFiles('config/skills'),
    ...activeFiles('config/agent-types'),
    'config/roles/defaults.yaml',
  ].filter((path) => forbidden.test(read(path)))
  expect(violations).toEqual([])
})

for (const provider of ['cloudflare', 'digitalocean', 'netlify', 'railway', 'supabase', 'vercel']) {
  test(`${provider} teaches explicit script and account selection without persistent credentials`, () => {
    const skill = read(`config/skills/deploy-${provider}/SKILL.md`)
    expect(skill).toContain(`ficus integration exec ${provider} -- npm run deploy`)
    expect(skill).toContain(`ficus integration exec ${provider} -- bun run deploy`)
    expect(skill).toContain(`ficus integration exec ${provider} -- pnpm run deploy`)
    expect(skill).toContain('--connection <connection-id>')
    expect(skill).toContain('--squad <squad-id>')
    expect(skill).toContain('Environment Variables')
    expect(skill).toMatch(/Never read, print, log, commit/)
    expect(skill).toContain('host runtime')
  })
}

test('channel setup uses owning settings, never token-bearing provider calls or restart for rotation', () => {
  for (const provider of ['discord', 'slack', 'telegram']) {
    const skill = read(`config/skills/setup-${provider}/SKILL.md`)
    expect(skill).toContain(`Settings → Integrations → ${provider[0]!.toUpperCase()}${provider.slice(1)}`)
    expect(skill).toContain('ficus channel list')
    expect(skill).not.toMatch(/ficus system restart|\$\(.*(?:TOKEN|secret)|api\.telegram\.org\/bot/)
    expect(skill).toContain('Never read, print, log or commit')
  }
  expect(read('config/skills/setup-telegram/SKILL.md')).toContain('Core registers the webhook')
})

test('CLI option remains compatible but describes metadata, not credential injection', () => {
  const command = read('apps/cli/src/commands/deploy.ts')
  expect(command).toMatch(/\.option\(\s*'--env-secret-ref <key>'/)
  expect(command).toContain('metadata only; not resolved or injected')
  expect(command).not.toContain('Secret Store key to expose to the process')
})

test('operator docs keep the person-only command, without obsolete delivery instructions', () => {
  for (const path of ['apps/cli/README.md', 'docs/wiki/cli/README.md']) {
    const doc = read(path)
    expect(doc).toContain('ficus secret')
    expect(doc).toContain('operator-only')
    expect(doc).toContain('Arbitrary keys are not delivered to squads')
    expect(doc).not.toMatch(/expose-secrets|expose-global|agent secrets/)
  }
  expect(read('docs/wiki/secret-store.md')).not.toContain('## Per-agent secrets')
})

test('Telegram routing uses the discovered numeric identity, not the username or token', () => {
  const skill = read('config/skills/setup-telegram/SKILL.md')
  expect(skill).toContain('numeric Bot ID')
  expect(skill).toContain('--config \'{"botId": "123456789"}\'')
  expect(skill).not.toContain('"botId": "myficus_bot"')
})

test('active credential wikis have no retired instructions or per-agent feature links', () => {
  for (const name of [
    'deployments',
    'secret-store',
    'integrations',
    'github-integrations',
    'settings-ui',
    'host-runtime',
    'integration-execution',
  ]) {
    expect({
      name,
      retired: /secret-store\.md#per-agent|expose-secrets|unexpose-secrets|expose-global|unexpose-global/.test(
        read(`docs/wiki/${name}.md`)
      ),
    }).toEqual({ name, retired: false })
  }
})

test('detection documentation tracks trusted authority, bounds and retired-token persistence', () => {
  const source = read('apps/core/src/services/security/squad-env-secret-source.ts')
  expect(source).toContain('const REFRESH_MS = 1000')
  expect(read('apps/core/src/services/security/squad-env-detection-repository.ts')).toContain(
    'MAX_SQUAD_ENV_BYTES = 256 * 1024'
  )
  expect(read('apps/core/src/services/security/integration-credential-entries.ts')).toContain(
    'MIN_INTEGRATION_CREDENTIAL_LENGTH = 8'
  )
  expect(read('apps/core/src/services/secrets/integration-retirement.ts')).toContain(
    'RETIRED_INTEGRATION_GRACE_MS = 60 * 60_000'
  )
  const doc = read('docs/wiki/integration-execution.md')
  for (const contract of [
    'shorter legacy leaves are not exact-matched',
    'Pattern-based detection remains independent',
    'encrypted durable one-hour retirement',
    'squad_env_detections',
    'no encryption-key dependency',
    'one-time legacy snapshot',
    '256 KiB',
    'at most once per second',
    'once per squad per process',
    'failed-query attribution',
    'PUBLIC',
    'PUBLISHABLE',
    'NEXT_PUBLIC_',
    'VITE_',
    'REACT_APP_',
  ])
    expect(doc).toContain(contract)
  expect(doc).not.toContain('Changes\nare rechecked at redaction boundaries with metadata-based parse caching')
  for (const path of ['docs/wiki/settings-ui.md', 'docs/upgrade/secret-exposure-retirement.md']) {
    const guidance = read(path)
    expect(guidance).toContain('256 KiB')
    expect(guidance).toContain('Settings')
    expect(guidance).toContain('direct disk edits')
  }
})

test('environment docs distinguish legacy promotion compatibility from ordinary capped writes', () => {
  const source = read('apps/core/src/services/security/squad-env-secret-source.ts')
  expect(source).toContain('async recordLegacyPromotion(')
  expect(source).toContain("{ contentHash: null, entries: [], reason: 'oversized' }")
  const regeneration = read('apps/core/src/services/squad/env.ts')
  expect(regeneration).toContain('await getSquadEnvSecretSource().recordLegacyPromotion(squadId, content, () =>')
  expect(regeneration).toContain("{ mode: 0o600, flag: 'wx' }")
  const doc = read('docs/wiki/integration-execution.md')
  for (const contract of [
    'first service creation',
    'full oversized legacy content',
    'atomically',
    '`oversized` with no entries',
    'Negative signature/hash results',
    'changed file signatures',
    'API/service or peer authority updates',
  ])
    expect(doc).toContain(contract)
  for (const path of ['docs/wiki/settings-ui.md', 'docs/upgrade/secret-exposure-retirement.md']) {
    const guidance = read(path)
    expect(guidance).toContain('legacy promotion')
    expect(guidance).toContain('oversized')
    expect(guidance).toContain('no entries')
    expect(guidance).toContain('ordinary API/service writes')
  }
})

// Cross-check setup prose against the owning implementation, not historical key names.
test('Discord setup matches the token-only form, discovered identity and optional HTTP UI', () => {
  const plugins = read('apps/core/src/services/integrations/channels/plugins.ts')
  const discordChannel = plugins.slice(plugins.lastIndexOf('credentialFields:'))
  expect([...discordChannel.matchAll(/key: '([^']+)'/g)].map((match) => match[1])).toEqual(['botToken'])
  expect(discordChannel).toContain('/applications/@me')
  const ui = read('apps/web/src/components/integrations/ChannelIntegrationSettings.tsx')
  expect(ui).toContain('Slash commands work through the gateway.')
  expect(ui).toContain('Optionally set the Interactions Endpoint URL')
  expect(ui).toContain('Server ID')
  const skill = read('config/skills/setup-discord/SKILL.md')
  expect(skill).toContain('Bot token is the only credential field')
  expect(skill).toContain('discovers the Application ID and public key')
  expect(skill).toContain('Server ID')
  expect(skill).toContain('HTTP delivery is optional')
  expect(skill).not.toMatch(/DISCORD_(?:APPLICATION_ID|PUBLIC_KEY|GUILD_ID)|copy:\n/)
})

test('Telegram setup respects the UI that hides its webhook URL', () => {
  const ui = read('apps/web/src/components/integrations/ChannelIntegrationSettings.tsx')
  expect(ui).toContain("data.webhook && provider !== 'telegram'")
  expect(ui).toContain('no URLs to paste')
  const skill = read('config/skills/setup-telegram/SKILL.md')
  expect(skill).toContain('no webhook URL to copy')
  expect(skill).toContain('Connection status')
  expect(skill).not.toMatch(/(?:displayed public|exact) webhook URL|panel supplies.*webhook URL/)
})
