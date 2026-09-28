import { describe, test, expect, afterEach } from 'bun:test'
import { bridgeLegacyEnv } from '@ficus/shared/legacy-env'
import {
  getManagedSecretKeys,
  getPublicManagedSecretKeys,
  isManagedSecretKey,
  isPlatformManaged,
  readManagedSecretValue,
} from './managed'

const originalManaged = process.env.FICUS_MANAGED
const originalKeys = process.env.FICUS_MANAGED_SECRET_KEYS

function setManagedKeys(value: string | undefined) {
  if (value === undefined) delete process.env.FICUS_MANAGED_SECRET_KEYS
  else process.env.FICUS_MANAGED_SECRET_KEYS = value
}

describe('platform-managed secret keys', () => {
  afterEach(() => {
    if (originalManaged === undefined) delete process.env.FICUS_MANAGED
    else process.env.FICUS_MANAGED = originalManaged
    setManagedKeys(originalKeys)
  })

  test('declared keys are managed; whitespace and empties are tolerated', () => {
    setManagedKeys(' APNS_KEY_ID , ,APNS_TEAM_ID ')
    expect([...getManagedSecretKeys()].sort()).toEqual(['APNS_KEY_ID', 'APNS_TEAM_ID'])
    expect(isManagedSecretKey('APNS_KEY_ID')).toBe(true)
    expect(isManagedSecretKey('OPENAI_API_KEY')).toBe(false)
  })

  test('a superseded key is managed when its superseding key is managed', () => {
    // The platform delivers the .p8 as a file + a managed APNS_KEY_P8_FILE.
    // The inline APNS_KEY_P8 WINS at resolve time, so it must be managed too —
    // otherwise a tenant could override the platform's push credential.
    setManagedKeys('APNS_KEY_P8_FILE,APNS_KEY_ID')
    expect(isManagedSecretKey('APNS_KEY_P8')).toBe(true)
    expect(getManagedSecretKeys().has('APNS_KEY_P8')).toBe(true)
  })

  test('the mapping is directional: managing the superseded key does not manage the superseding one', () => {
    setManagedKeys('APNS_KEY_P8')
    expect(isManagedSecretKey('APNS_KEY_P8')).toBe(true)
    expect(isManagedSecretKey('APNS_KEY_P8_FILE')).toBe(false)
    expect(getManagedSecretKeys().has('APNS_KEY_P8_FILE')).toBe(false)
  })

  test('a superseded key whose superseding key is NOT managed is unaffected', () => {
    setManagedKeys('APNS_KEY_ID')
    expect(isManagedSecretKey('APNS_KEY_P8')).toBe(false)
    expect(getManagedSecretKeys().has('APNS_KEY_P8')).toBe(false)
  })

  // ── env-name / encoding aliases ────────────────────────────────────────
  //
  // Two properties of /etc/tau/managed.env break the usual "the store key IS
  // the env var name, holding the plaintext" assumption, and the exe.dev
  // account SSH key hits both: systemd cannot set a name containing a hyphen,
  // and an EnvironmentFile value cannot span lines.

  test('declaring EXE_PROVIDER_SSH_KEY manages the hyphenated secret it actually names', () => {
    setManagedKeys('EXE_PROVIDER_SSH_KEY')
    // Without this, a stale `exe-provider-ssh-key` DB row would keep shadowing
    // the platform-delivered value — the exact failure the managed set exists
    // to prevent.
    expect(isManagedSecretKey('exe-provider-ssh-key')).toBe(true)
    expect(getManagedSecretKeys().has('exe-provider-ssh-key')).toBe(true)
  })

  test('a self-hosted install is untouched: the aliased key stays an ordinary editable secret', () => {
    setManagedKeys(undefined)
    expect(isManagedSecretKey('exe-provider-ssh-key')).toBe(false)
    setManagedKeys('APNS_KEY_ID')
    expect(isManagedSecretKey('exe-provider-ssh-key')).toBe(false)
  })

  test('readManagedSecretValue decodes the aliased, base64-delivered value back to the PEM', () => {
    const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n'
    const prior = process.env.EXE_PROVIDER_SSH_KEY
    process.env.EXE_PROVIDER_SSH_KEY = Buffer.from(pem, 'utf8').toString('base64')
    try {
      expect(readManagedSecretValue('exe-provider-ssh-key')).toBe(pem)
      // The hyphenated name is never an env var — reading it directly finds nothing.
      expect(process.env['exe-provider-ssh-key']).toBeUndefined()
    } finally {
      if (prior === undefined) delete process.env.EXE_PROVIDER_SSH_KEY
      else process.env.EXE_PROVIDER_SSH_KEY = prior
    }
  })

  test('a value that is not exactly round-tripping base64 resolves to NOTHING, never to garbage', () => {
    // A key one byte wrong is an SSH authentication failure nobody can trace
    // back to its cause; an absent credential fails where it is missing.
    const prior = process.env.EXE_PROVIDER_SSH_KEY
    try {
      for (const bad of ['-----BEGIN OPENSSH PRIVATE KEY-----', 'not base64!!', 'YWJj=', 'YWJ j']) {
        process.env.EXE_PROVIDER_SSH_KEY = bad
        expect(readManagedSecretValue('exe-provider-ssh-key')).toBeUndefined()
      }
      delete process.env.EXE_PROVIDER_SSH_KEY
      expect(readManagedSecretValue('exe-provider-ssh-key')).toBeUndefined()
    } finally {
      if (prior === undefined) delete process.env.EXE_PROVIDER_SSH_KEY
      else process.env.EXE_PROVIDER_SSH_KEY = prior
    }
  })

  test('an unaliased managed key still reads straight from its own env var', () => {
    const prior = process.env.APNS_KEY_ID
    process.env.APNS_KEY_ID = 'ABC123'
    try {
      expect(readManagedSecretValue('APNS_KEY_ID')).toBe('ABC123')
    } finally {
      if (prior === undefined) delete process.env.APNS_KEY_ID
      else process.env.APNS_KEY_ID = prior
    }
  })

  test('retired Notion OAuth declarations stay managed but never become public or recreate aliases', () => {
    setManagedKeys('NOTION_OAUTH_CLIENT_ID,NOTION_OAUTH_CLIENT_SECRET,SES_ACCESS_KEY_ID')

    expect(isManagedSecretKey('NOTION_OAUTH_CLIENT_ID')).toBe(true)
    expect(isManagedSecretKey('NOTION_OAUTH_CLIENT_SECRET')).toBe(true)
    expect(isManagedSecretKey('__integration-oauth-client-id:notion')).toBe(false)
    expect(isManagedSecretKey('__integration-oauth-client-secret:notion')).toBe(false)
    expect(getManagedSecretKeys().has('__integration-oauth-client-id:notion')).toBe(false)
    expect(getManagedSecretKeys().has('__integration-oauth-client-secret:notion')).toBe(false)
    expect([...getPublicManagedSecretKeys()]).not.toContain('NOTION_OAUTH_CLIENT_ID')
    expect([...getPublicManagedSecretKeys()]).not.toContain('NOTION_OAUTH_CLIENT_SECRET')
    expect([...getPublicManagedSecretKeys()]).toContain('SES_ACCESS_KEY_ID')
    process.env.NOTION_OAUTH_CLIENT_ID = 'hostile-retired-value'
    process.env.NOTION_OAUTH_CLIENT_SECRET = 'hostile-retired-value'
    expect(readManagedSecretValue('__integration-oauth-client-id:notion')).toBeUndefined()
    expect(readManagedSecretValue('__integration-oauth-client-secret:notion')).toBeUndefined()
    delete process.env.NOTION_OAUTH_CLIENT_ID
    delete process.env.NOTION_OAUTH_CLIENT_SECRET
  })

  test('platform identity and usage tokens are never public managed-key names', () => {
    setManagedKeys('FICUS_PLATFORM_INSTANCE_TOKEN,FICUS_PLATFORM_USAGE_TOKEN,SES_ACCESS_KEY_ID')
    const publicKeys = [...getPublicManagedSecretKeys()]
    expect(publicKeys).not.toContain('FICUS_PLATFORM_INSTANCE_TOKEN')
    expect(publicKeys).not.toContain('FICUS_PLATFORM_USAGE_TOKEN')
    expect(publicKeys).toContain('SES_ACCESS_KEY_ID')
  })

  test('relay credentials remain Core-only on a self-hosted instance', () => {
    setManagedKeys(undefined)
    expect(isManagedSecretKey('FICUS_PUSH_RELAY_TOKEN')).toBe(true)
    expect([...getPublicManagedSecretKeys()]).not.toContain('FICUS_PUSH_RELAY_TOKEN')
  })

  test('retained TAU_ rows stay managed and private on a bridged env (one release)', () => {
    // What a pre-rename managed.env delivers, after the boot bridge.
    const delivered: Record<string, string | undefined> = {
      TAU_MANAGED_SECRET_KEYS: 'TAU_PLATFORM_INSTANCE_TOKEN,TAU_PLATFORM_USAGE_TOKEN,SES_ACCESS_KEY_ID',
    }
    bridgeLegacyEnv(delivered)
    setManagedKeys(delivered.FICUS_MANAGED_SECRET_KEYS)
    const priorToken = process.env.FICUS_PLATFORM_INSTANCE_TOKEN
    process.env.FICUS_PLATFORM_INSTANCE_TOKEN = 'instance-canary'
    try {
      expect(isManagedSecretKey('TAU_PUSH_RELAY_TOKEN')).toBe(true)
      expect(isManagedSecretKey('TAU_PLATFORM_INSTANCE_TOKEN')).toBe(true)
      expect(isManagedSecretKey('TAU_PLATFORM_USAGE_TOKEN')).toBe(true)
      expect(isManagedSecretKey('TAU_SES_ACCESS_KEY_ID')).toBe(false)
      const publicKeys = [...getPublicManagedSecretKeys()]
      expect(publicKeys.filter((key) => key.startsWith('TAU_'))).toEqual([])
      expect(publicKeys).toContain('SES_ACCESS_KEY_ID')
      // A retained legacy key resolves to the value the bridge moved.
      expect(readManagedSecretValue('TAU_PLATFORM_INSTANCE_TOKEN')).toBe('instance-canary')
    } finally {
      if (priorToken === undefined) delete process.env.FICUS_PLATFORM_INSTANCE_TOKEN
      else process.env.FICUS_PLATFORM_INSTANCE_TOKEN = priorToken
    }
  })

  test('the legacy relay credential is private even on a self-hosted instance (one release)', () => {
    setManagedKeys(undefined)
    expect(isManagedSecretKey('TAU_PUSH_RELAY_TOKEN')).toBe(true)
    expect(isManagedSecretKey('TAU_PLATFORM_INSTANCE_TOKEN')).toBe(false)
  })

  test('self-hosted (no FICUS_MANAGED_SECRET_KEYS): nothing is managed, superseded keys included', () => {
    delete process.env.FICUS_MANAGED
    setManagedKeys(undefined)
    expect(isPlatformManaged()).toBe(false)
    expect(getManagedSecretKeys().size).toBe(0)
    expect(isManagedSecretKey('APNS_KEY_P8')).toBe(false)
    expect(isManagedSecretKey('APNS_KEY_P8_FILE')).toBe(false)
    expect(isManagedSecretKey('exe-provider-ssh-key')).toBe(false)
  })
})
