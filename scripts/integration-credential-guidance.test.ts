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
