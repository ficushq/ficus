import { boundedRecord } from '@ficus/shared'
import { z } from 'zod'
import { getSecretStore, isManagedSecretKey } from '../secrets'

export interface IntegrationCredentialField {
  key: string
  label: string
  required?: boolean
  secret: boolean
  multiline?: boolean
  placeholder: string
}

export function readIntegrationCredentialFields(fields: readonly IntegrationCredentialField[]) {
  const store = getSecretStore()
  return {
    fields: fields.map((field) => ({
      ...field,
      configured: !!store.get(field.key)?.trim(),
      managed: isManagedSecretKey(field.key),
      ...(field.secret || isManagedSecretKey(field.key) ? {} : { value: store.get(field.key) ?? '' }),
    })),
  }
}

export async function writeIntegrationCredentialFields(
  fields: readonly IntegrationCredentialField[],
  input: unknown,
  actor: string
) {
  const values = boundedRecord(z.record(z.string(), z.string().max(16384).nullable()), 256).parse(input)
  const allowed = new Set(fields.map((field) => field.key))
  if (Object.keys(values).some((key) => !allowed.has(key))) throw new Error('Unknown integration credential field')
  if (Object.keys(values).some(isManagedSecretKey)) throw new Error('This credential is managed by your platform.')
  for (const field of fields) {
    if (field.required && Object.hasOwn(values, field.key) && !values[field.key]?.trim())
      throw new Error(`${field.label} is required.`)
  }
  for (const [key, value] of Object.entries(values)) await getSecretStore().set(key, value ?? '', actor)
  return readIntegrationCredentialFields(fields)
}
