import { describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { queryKeys, integrationQueryKeys } from '../../queryKeys'
import { SecretsSection } from './SecretsSection'
import {
  SECRET_REGISTRY,
  buildSecretRegistry,
  isGitHubTokenSecretKey,
  visibleRegistryEntries,
  type SecretRegistryEntry,
} from './secretsRegistry'
import type { SecretMetadata } from '../../api/secrets'

const APNS_KEYS = ['APNS_KEY_P8', 'APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_BUNDLE_ID', 'APNS_ENV']
const PLATFORM_MANAGED_KEYS = [...APNS_KEYS, 'VAPID_SUBJECT']

function entry(overrides: Partial<SecretRegistryEntry> = {}): SecretRegistryEntry {
  return { key: 'K', name: 'K name', description: 'K description', category: 'Cat', ...overrides }
}

function render({
  secrets = [],
  managedKeys = [],
  managed,
  exeBacked,
  permissions = ['secrets:write'],
  github = null,
  scope = 'git',
}: {
  scope?: 'git' | 'machines'
  secrets?: SecretMetadata[]
  managedKeys?: string[]
  managed?: boolean
  exeBacked?: boolean
  permissions?: string[]
  github?: { login: string; gitUserName: string; gitUserEmail: string } | null
}): string {
  const qc = new QueryClient()
  qc.setQueryData(integrationQueryKeys.gitAuthorDefaults(), { github })
  qc.setQueryData(queryKeys.secrets.list(), { secrets, managedKeys, managed, exeBacked })
  qc.setQueryData(['workspace-env', 'global-secrets'], { globallyExposedSecretKeys: [] })
  qc.setQueryData(queryKeys.auth.permissions(undefined), { permissions })
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <SecretsSection scope={scope} />
    </QueryClientProvider>
  )
}

/** The markup of one row: from its display name to the end of that row's block. */
function row(html: string, name: string): string {
  const start = html.indexOf(name)
  expect(start).toBeGreaterThan(-1)
  const rest = html.slice(start)
  const end = rest.indexOf('<div class="px-4 py-3"', 1)
  return end === -1 ? rest : rest.slice(0, end)
}

describe('visibleRegistryEntries', () => {
  test('hides a hideIfManaged entry only once the platform manages its key', () => {
    const registry = [entry({ key: 'HIDDEN', hideIfManaged: true })]
    expect(visibleRegistryEntries(registry, new Set(['HIDDEN']))).toEqual([])
    expect(visibleRegistryEntries(registry, new Set())).toEqual(registry)
    // A managed key with a DIFFERENT name must not hide it.
    expect(visibleRegistryEntries(registry, new Set(['OTHER']))).toEqual(registry)
  })

  test('keeps an entry without the flag even when it is managed', () => {
    const registry = [entry({ key: 'SHOWN' })]
    expect(visibleRegistryEntries(registry, new Set(['SHOWN']))).toEqual(registry)
  })

  test('hides hosted infrastructure credentials regardless of the machine substrate', () => {
    const registry = [entry({ key: 'EXE', hideWhenHosted: true })]
    expect(visibleRegistryEntries(registry, new Set(), { managed: true, exeBacked: false })).toEqual([])
    expect(visibleRegistryEntries(registry, new Set(), { managed: true, exeBacked: true })).toEqual([])
    // Self-hosted: never hidden, regardless of exeBacked.
    expect(visibleRegistryEntries(registry, new Set(), { managed: false, exeBacked: false })).toEqual(registry)
    // No context at all (existing 2-arg callers): never hidden.
    expect(visibleRegistryEntries(registry, new Set())).toEqual(registry)
  })
})

describe('isGitHubTokenSecretKey', () => {
  test('matches the server validation key shapes', () => {
    for (const key of ['DEPLOY_GITHUB_PAGES_TOKEN']) {
      expect(isGitHubTokenSecretKey(key)).toBe(false)
    }
    for (const key of [
      'GITHUB_TOKEN',
      'GH_TOKEN',
      'GITHUB_TOKEN_ACME',
      'GITHUB_WEBHOOK_SECRET',
      'DEPLOY_VERCEL_TOKEN',
      'GITHUB_TOKENX',
    ]) {
      expect(isGitHubTokenSecretKey(key)).toBe(false)
    }
  })
})

describe('SECRET_REGISTRY flags', () => {
  test('push infrastructure and bootstrap password have moved out of the registry', () => {
    expect(SECRET_REGISTRY.some((entry) => [...PLATFORM_MANAGED_KEYS, 'FICUS_PASSWORD'].includes(entry.key))).toBe(
      false
    )
  })

  test('the exe.dev key carries no managed flag — seed.sh writes it to the store', () => {
    const exe = SECRET_REGISTRY.find((e) => e.key === 'exe-provider-ssh-key')!
    expect(exe.hideIfManaged).toBeUndefined()
  })

  test('the exe.dev key is hidden on every hosted instance', () => {
    const flagged = SECRET_REGISTRY.filter((e) => e.hideWhenHosted).map((e) => e.key)
    expect(flagged).toEqual(['exe-provider-ssh-key'])
  })

  test('legacy GitHub token entries are not offered by the registry', () => {
    const built = buildSecretRegistry([
      { key: 'GITHUB_TOKEN_ACME', isSet: true, updatedAt: null, updatedBy: null },
      { key: 'GITHUB_TOKEN', isSet: true, updatedAt: null, updatedBy: null },
    ])
    expect(built.filter((e) => e.key === 'GITHUB_TOKEN_ACME')).toHaveLength(0)
    expect(built.filter((e) => e.key === 'GITHUB_TOKEN')).toHaveLength(0)
  })
})

describe('SecretsSection rendering', () => {
  test('Git settings only show author overrides', () => {
    const html = render({ managed: false })
    expect(html).toContain('Git Author Name')
    for (const label of ['APNs', 'VAPID', 'Admin Password', 'exe.dev', 'Secrets &amp; Keys'])
      expect(html).not.toContain(label)
  })

  test('managed instance: hideIfManaged entries vanish and an emptied category has no heading', () => {
    const html = render({ managed: true, managedKeys: PLATFORM_MANAGED_KEYS })
    // Every APNs entry is gone…
    expect(html).not.toContain('APNs Auth Key (.p8)')
    expect(html).not.toContain('Apple Team ID')
    // …so the whole category heading goes with them, with no name special-case.
    expect(html).not.toContain('Apple Push (APNs)')
    // Same for the lone entry in Notifications.
    expect(html).not.toContain('VAPID Subject')
    expect(html).not.toContain('>Notifications<')
    // Unrelated categories are untouched.
    expect(html).toContain('Git Author Name')
  })

  test('service integration credentials are absent even when platform-managed', () => {
    const html = render({ managed: true, managedKeys: ['OPENAI_API_KEY', 'GOOGLE_SERVICE_ACCOUNT_JSON'] })
    expect(html).not.toContain('OpenAI API Key')
    expect(html).not.toContain('Service Account JSON')
  })

  test('self-hosted: the exe.dev key is an ordinary editable row', () => {
    const html = render({ scope: 'machines', managed: false })
    const exe = row(html, 'exe.dev account SSH private key')
    expect(exe).toContain('Not set')
    expect(exe).toContain('<button')
    expect(html).not.toContain('Managed by your platform')
  })

  test('hosted exe-backed instances hide a configured key and its controls', () => {
    const html = render({
      scope: 'machines',
      managed: true,
      managedKeys: [],
      exeBacked: true,
      secrets: [{ key: 'exe-provider-ssh-key', isSet: true, updatedAt: null, updatedBy: 'legacy' }],
    })
    expect(html).not.toContain('exe.dev account SSH private key')
    expect(html).not.toContain('>Machines<')
  })

  // do-machine-mode-part2 Task 7: a managed instance whose substrate is
  // do_droplet (the platform default) has no exe.dev key anywhere in its
  // flow — the row (and its now-empty "Machines" category) must not render
  // at all. Spec: hide, never delete — this is the HIDE half.
  test('managed instance, not exe-backed: the exe.dev key row (and its category) is hidden entirely', () => {
    const html = render({ scope: 'machines', managed: true, managedKeys: PLATFORM_MANAGED_KEYS, exeBacked: false })
    expect(html).not.toContain('exe.dev account SSH private key')
    expect(html).not.toContain('>Machines<')
  })

  // Both directions: self-hosted instances never hide it, even before
  // `exeBacked` is known to be true — an admin may still be choosing exe as
  // their sandbox provider and needs to be able to set the key up at all.
  test('self-hosted, not (yet) exe-backed: the exe.dev key row still renders', () => {
    const html = render({ scope: 'machines', managed: false, exeBacked: false })
    expect(html).toContain('exe.dev account SSH private key')
  })
})

describe('retired GitHub token configuration', () => {
  test('does not offer token entry even to a secrets administrator', () => {
    const html = render({})
    expect(html).not.toContain('+ Add another GitHub token')
    expect(html).not.toContain('Paste GitHub token')
    expect(html).not.toContain('GitHub Token</span>')
  })
  test('does not expose webhook configuration in legacy secret settings', () => {
    expect(render({})).not.toContain('Secret for verifying GitHub webhook signatures')
    expect(SECRET_REGISTRY.some((entry) => entry.key === 'GITHUB_WEBHOOK_SECRET')).toBe(false)
  })
})

test('deployment tokens are managed in integration cards, not the Secrets & Keys registry', () => {
  expect(SECRET_REGISTRY.filter((entry) => entry.key.startsWith('DEPLOY_'))).toHaveLength(0)
})

test('Git author rows show inherited GitHub identity and identify saved overrides', () => {
  const github = {
    login: 'test-user',
    gitUserName: 'Test User',
    gitUserEmail: '123+test-user@users.noreply.github.com',
  }
  const inherited = render({ github })
  expect(row(inherited, 'Git Author Name')).toContain('GitHub default (@test-user)')
  expect(row(inherited, 'Git Author Name')).toContain('Test User')
  expect(row(inherited, 'Git Author Email')).toContain(github.gitUserEmail)
  expect(row(inherited, 'Git Author Name')).toContain('Used automatically')
  const overridden = render({
    github,
    secrets: [{ key: 'GIT_USER_NAME', isSet: true, updatedAt: null, updatedBy: null }],
  })
  expect(row(overridden, 'Git Author Name')).toContain('Clear the override to use this default')
})
