import { z } from 'zod'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { expandTilde } from '@ficus/shared/node'
import webpush from 'web-push'
import { CONFIG_DIR } from '../../lib/paths'
import { getSecretStore } from '../secrets'
import { createLogger } from '../../lib/infra/logger'

const log = createLogger('push')

export interface VapidKeys {
  publicKey: string
  privateKey: string
}

const DEFAULT_VAPID_PATH = join(CONFIG_DIR, 'vapid.json')

export function getVapidKeysPath(): string {
  return expandTilde(process.env.VAPID_KEYS_PATH || DEFAULT_VAPID_PATH)
}

/**
 * Load VAPID keys from SecretStore, falling back to a legacy file, then auto-generating.
 *
 * Priority:
 * 1. SecretStore (VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY) — the only store
 * 2. File (config/vapid.json) — read only, for old self-hosted installs; migrates to SecretStore
 * 3. Auto-generate new keys → store in SecretStore
 *
 * No key file is ever written: the release tree is read-only to a non-root Core, and a private
 * key has no business in it.
 */
export async function loadOrGenerateVapidKeys(path: string = getVapidKeysPath()): Promise<VapidKeys> {
  const store = getSecretStore()

  // 1. Try SecretStore
  const publicKey = store.get('VAPID_PUBLIC_KEY')
  const privateKey = store.get('VAPID_PRIVATE_KEY')
  if (publicKey && privateKey) {
    return { publicKey, privateKey }
  }

  // 2. Try file (and migrate to SecretStore if possible)
  try {
    const content = await readFile(path, 'utf-8')
    const keys = JSON.parse(content) as VapidKeys
    // Migrate to SecretStore (best-effort — may fail without encryption key)
    try {
      await store.set('VAPID_PUBLIC_KEY', keys.publicKey, 'env')
      await store.set('VAPID_PRIVATE_KEY', keys.privateKey, 'env')
      log.info('Migrated VAPID keys from file to SecretStore')
    } catch {
      // Non-fatal — file is still the source of truth
    }
    return keys
  } catch (err: any) {
    if (err.code !== 'ENOENT') {
      log.warn(`Failed to read VAPID file at ${path}: ${err.message}`)
    }
  }

  // 3. Auto-generate
  const vapidKeys = webpush.generateVAPIDKeys()
  const keys: VapidKeys = {
    publicKey: vapidKeys.publicKey,
    privateKey: vapidKeys.privateKey,
  }

  // Store in SecretStore (best-effort: without it the keys last only for this process)
  try {
    await store.set('VAPID_PUBLIC_KEY', keys.publicKey, 'system')
    await store.set('VAPID_PRIVATE_KEY', keys.privateKey, 'system')
    log.info('Auto-generated VAPID keys and stored in SecretStore')
  } catch (err) {
    log.warn(
      `Generated VAPID keys could not be stored in SecretStore (${(err as Error).message}); ` +
        'browsers will need to re-subscribe after the next restart'
    )
  }

  return keys
}

let cachedKeys: VapidKeys | null = null

export async function getVapidKeys(): Promise<VapidKeys> {
  if (!cachedKeys) {
    cachedKeys = await loadOrGenerateVapidKeys()
  }
  return cachedKeys
}

/** A real operator contact is required before browser push can be used. */
export function getVapidContactSubject(value = getSecretStore().get('VAPID_SUBJECT')): string | undefined {
  const subject = value?.trim()
  if (!subject) return undefined
  try {
    const url = new URL(subject)
    if (
      url.protocol === 'mailto:'
        ? z.string().email().safeParse(url.pathname).success
        : url.protocol === 'https:' && !!url.hostname
    )
      return subject
  } catch {
    /* Invalid contact addresses leave setup incomplete. */
  }
  return undefined
}
