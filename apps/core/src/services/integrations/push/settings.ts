import { existsSync } from 'node:fs'
import { createPrivateKey } from 'node:crypto'
import { z } from 'zod'
import { getSecretStore, isManagedSecretKey } from '../../secrets'
import { getSettingsStore } from '../../settings'
import { getVapidContactSubject, getVapidKeysPath } from '../../push/vapid'
import { EXPECTED_APNS_BUNDLE_ID, normalizePemKey } from '../../push/apns'
import {
  readIntegrationCredentialFields,
  writeIntegrationCredentialFields,
  type IntegrationCredentialField,
} from '../credential-settings'
import type { SafeIntegrationCatalogEntry } from '../plugin'

const fields: Record<string, IntegrationCredentialField[]> = {
  'apple-push': [
    {
      key: 'APNS_KEY_P8',
      required: true,
      label: 'APNs authentication key (.p8)',
      secret: true,
      multiline: true,
      placeholder: 'Paste the private key from Apple Developer',
    },
    { key: 'APNS_KEY_ID', required: true, label: 'Key ID', secret: false, placeholder: '10-character Apple key ID' },
    { key: 'APNS_TEAM_ID', required: true, label: 'Team ID', secret: false, placeholder: '10-character Apple team ID' },
    {
      key: 'APNS_BUNDLE_ID',
      required: true,
      label: 'App bundle ID',
      secret: false,
      placeholder: EXPECTED_APNS_BUNDLE_ID,
    },
    {
      key: 'APNS_ENV',
      label: 'Environment',
      secret: false,
      placeholder: 'production (or sandbox for development builds)',
    },
  ],
  'web-push': [
    {
      key: 'VAPID_SUBJECT',
      required: true,
      label: 'Contact address',
      secret: false,
      placeholder: 'mailto:admin@example.com',
    },
  ],
}
export function isPushIntegration(provider: string) {
  return Object.hasOwn(fields, provider)
}
export const pushIntegrationCatalog: SafeIntegrationCatalogEntry[] = [
  {
    key: 'apple-push',
    label: 'Apple Push',
    description: 'Deliver native iOS notifications and Live Activity updates through APNs.',
  },
  {
    key: 'web-push',
    label: 'Web Push',
    description: 'Send notifications to subscribed browsers and installed web apps.',
  },
].map((entry) => ({
  ...entry,
  manifestVersion: 1,
  adapterVersion: 1,
  icon: entry.key as 'apple-push' | 'web-push',
  connectionMode: 'service',
  assignable: false,
  requiredCapabilities: [],
  sandbox: { packages: [], skills: [], extensions: [], protectedBindingNames: [] },
}))

export function getPushIntegrationSettings(provider: string) {
  if (!isPushIntegration(provider)) throw new Error('Unknown push integration')
  const result = readIntegrationCredentialFields(fields[provider])
  // Hosted .p8 keys may arrive as protected files instead of inline secrets.
  if (provider === 'apple-push' && isManagedSecretKey('APNS_KEY_P8_FILE')) {
    const field = result.fields.find((f) => f.key === 'APNS_KEY_P8')!
    field.managed = true
    field.configured = !!getSecretStore().get('APNS_KEY_P8_FILE')
  }
  if (provider === 'web-push') result.fields[0].configured = !!getVapidContactSubject()
  return result
}
export async function configurePushIntegration(provider: string, input: unknown, actor: string) {
  if (!isPushIntegration(provider)) throw new Error('Unknown push integration')
  const values = z.record(z.string(), z.string().max(16384).nullable()).parse(input)
  if (
    Object.keys(values).some((key) => getPushIntegrationSettings(provider).fields.find((f) => f.key === key)?.managed)
  )
    throw new Error('This credential is managed by your platform.')
  if (values.APNS_ENV && !['production', 'sandbox'].includes(values.APNS_ENV))
    throw new Error('Environment must be production or sandbox.')
  for (const key of ['APNS_KEY_ID', 'APNS_TEAM_ID'])
    if (values[key] && !/^[A-Z0-9]{10}$/.test(values[key]!))
      throw new Error('Apple key and team IDs must contain 10 uppercase letters or digits.')
  if (values.APNS_KEY_P8) {
    try {
      const key = createPrivateKey(normalizePemKey(values.APNS_KEY_P8))
      if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error()
    } catch {
      throw new Error('Enter a valid Apple APNs .p8 signing key (P-256).')
    }
  }
  if (values.VAPID_SUBJECT) {
    try {
      const url = new URL(values.VAPID_SUBJECT)
      if (
        url.protocol === 'mailto:'
          ? !z.string().email().safeParse(url.pathname).success
          : url.protocol !== 'https:' || !url.hostname
      )
        throw new Error()
    } catch {
      throw new Error('Use a mailto: email address or https: contact URL.')
    }
  }
  await writeIntegrationCredentialFields(fields[provider], values, actor)
  return getPushIntegrationSettings(provider)
}
export async function initializePushIntegrationStates() {
  const { db, settings } = await import('../../../db')
  const store = getSecretStore()
  const configured = {
    'apple-push':
      !!(store.get('APNS_KEY_P8') || store.get('APNS_KEY_P8_FILE')) &&
      !!store.get('APNS_KEY_ID') &&
      !!store.get('APNS_TEAM_ID') &&
      !!store.get('APNS_BUNDLE_ID'),
    'web-push': !!store.get('VAPID_SUBJECT') || !!store.get('VAPID_PUBLIC_KEY') || existsSync(getVapidKeysPath()),
  }
  for (const [provider, enabled] of Object.entries(configured)) {
    const key = `__integration-enabled:${provider}`
    await db
      .insert(settings)
      .values({ key, value: String(enabled) })
      .onConflictDoNothing()
    await getSettingsStore().refreshKey(key)
  }
}
export async function setPushIntegrationEnabled(provider: string, enabled: boolean, actor: string) {
  if (!isPushIntegration(provider)) throw new Error('Unknown push integration')
  await getSettingsStore().set(`__integration-enabled:${provider}`, String(enabled), actor)
  return { enabled }
}
