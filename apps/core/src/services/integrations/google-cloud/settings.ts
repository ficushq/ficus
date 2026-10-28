import { boundedRecord } from '@ficus/shared'
import { z } from 'zod'
import { createPrivateKey } from 'node:crypto'
import { getSecretStore } from '../../secrets'
import { getSettingsStore } from '../../settings'
import { isIntegrationEnabled } from '../provider-state'
import { readIntegrationCredentialFields, writeIntegrationCredentialFields } from '../credential-settings'
import type { SafeIntegrationCatalogEntry } from '../plugin'

export const GOOGLE_CLOUD_PROVIDER = 'google-cloud'
export const GOOGLE_CLOUD_CREDENTIAL = 'GOOGLE_SERVICE_ACCOUNT_JSON'
const enabledKey = '__integration-enabled:google-cloud'
const fields = [
  {
    key: GOOGLE_CLOUD_CREDENTIAL,
    required: true,
    label: 'Service account JSON',
    secret: true,
    multiline: true,
    placeholder: 'Paste the JSON key downloaded for your Google Cloud service account',
  },
]
export const googleCloudIntegrationCatalog: SafeIntegrationCatalogEntry = {
  manifestVersion: 1,
  key: GOOGLE_CLOUD_PROVIDER,
  adapterVersion: 1,
  label: 'Google Cloud',
  description: 'Read agent messages aloud with Google Cloud Text-to-Speech.',
  icon: 'google-cloud',
  connectionMode: 'service',
  assignable: false,
  requiredCapabilities: [],
  sandbox: { packages: [], skills: [], extensions: [], protectedBindingNames: [] },
}
export function parseGoogleServiceAccount(value: string) {
  try {
    const credentials = z
      .object({
        type: z.literal('service_account'),
        client_email: z.string().email(),
        private_key: z.string().min(1),
      })
      .passthrough()
      .parse(JSON.parse(value))
    if (createPrivateKey(credentials.private_key).asymmetricKeyType !== 'rsa') throw new Error()
    return credentials
  } catch {
    throw new Error('Enter a valid Google Cloud service account JSON key.')
  }
}
export function getGoogleCloudIntegrationSettings() {
  const result = readIntegrationCredentialFields(fields)
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    result.fields[0].configured = true
    result.fields[0].required = false
  }
  return result
}
export async function configureGoogleCloudIntegration(input: unknown, actor: string) {
  const values = boundedRecord(z.record(z.string(), z.string().max(16384).nullable()), 256).parse(input)
  const value = values[GOOGLE_CLOUD_CREDENTIAL]
  if (value) parseGoogleServiceAccount(value)
  return writeIntegrationCredentialFields(fields, values, actor)
}
export async function initializeGoogleCloudIntegrationState() {
  const { db, settings } = await import('../../../db')
  // Preserve explicit service-account and ADC-file installations on upgrade.
  const configured = !!getSecretStore().get(GOOGLE_CLOUD_CREDENTIAL) || !!process.env.GOOGLE_APPLICATION_CREDENTIALS
  await db
    .insert(settings)
    .values({ key: enabledKey, value: String(configured) })
    .onConflictDoNothing()
  await getSettingsStore().refreshKey(enabledKey)
}
export async function setGoogleCloudIntegrationEnabled(enabled: boolean, actor: string) {
  await getSettingsStore().set(enabledKey, String(enabled), actor)
  return { enabled }
}
export async function requireGoogleCloudSpeechEnabled() {
  if (!(await isIntegrationEnabled(GOOGLE_CLOUD_PROVIDER)))
    throw new Error('Enable Google Cloud in Settings → Integrations to use text-to-speech.')
}
