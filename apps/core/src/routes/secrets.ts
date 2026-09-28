import { getGitHubAuthorDefaults } from '../services/integrations/github/author-defaults'
import { deploymentProviderForSecret } from '../services/integrations/deployment/settings'
import { isChannelCredential } from '../services/integrations/channels/settings'
import { Hono } from 'hono'
import { requireSecretKeyPermission, requireSecretListAccess } from '../middleware/require-secret-permission'
import { getSecretStore, getPublicManagedSecretKeys, isManagedSecretKey, isPlatformManaged } from '../services/secrets'
import { resolvePermissions, auditActor, type Identity } from '../services/rbac'
import { secretAccessible } from '../services/secrets/groups'
import { isExeBacked } from '../services/machines/provider-credentials'
import { parseJsonBody } from './json-body'
import { createLogger } from '../lib/infra/logger'
import { getSecretValidator, type SecretValidation } from '../services/secrets/validators'

const app = new Hono()
const log = createLogger('secrets-route')

// Platform-managed credentials are set on the tenant's behalf and must never be
// readable or writable by tenant users. Reads/writes/deletes of a managed key
// fail closed (403), and the value is refused before the store is ever touched.
const retiredIntegrationKey = (key: string) =>
  isChannelCredential(key) ||
  !!deploymentProviderForSecret(key) ||
  /^(?:GH_TOKEN|GITHUB_TOKEN)(?:_|$)/.test(key) ||
  key === 'GOOGLE_SERVICE_ACCOUNT_JSON' ||
  key === 'OPENAI_API_KEY' ||
  key === 'GITHUB_USER' ||
  key === 'DEPLOY_GITHUB_PAGES_TOKEN' ||
  key === 'GITHUB_WEBHOOK_SECRET' ||
  ['LINEAR_API_KEY', 'LINEAR_WEBHOOK_SECRET', 'LINEAR_USER_ID'].includes(key)

const isHiddenHostedSecret = (key: string) => key === 'exe-provider-ssh-key' && isPlatformManaged()

const MANAGED_SECRET_ERROR = 'This secret is managed by your platform and cannot be read or changed here.'

/**
 * List all known secrets with status (no values), plus the platform-managed key
 * names and whether this instance is platform-managed at all.
 */
app.get('/', requireSecretListAccess(), async (c) => {
  const identity = c.get('identity') as Identity
  const heldPermissions = await resolvePermissions(identity)
  const store = getSecretStore()
  const list = await store.list()
  return c.json({
    // `list()` already excludes managed keys — no value/metadata for them ever
    // leaves the process. `managedKeys` carries only the NAMES (not sensitive:
    // the same names ship in the mobile app), so the UI can render a
    // "Managed by your platform" placeholder instead of editable fields.
    secrets: list.filter(
      (secret) =>
        !retiredIntegrationKey(secret.key) &&
        !isHiddenHostedSecret(secret.key) &&
        secretAccessible(heldPermissions, secret.key, 'read')
    ),
    managedKeys: [...getPublicManagedSecretKeys()].sort(),
    // Instance-level flag (FICUS_MANAGED=1), NOT a per-key one. Some credentials
    // the platform provides never appear in `managedKeys` because they are not
    // delivered as managed env vars (the exe.dev account SSH key ships as a
    // file the tenant's setup config points at). The UI needs to know it is on
    // a managed instance to describe those honestly instead of "not set". This
    // is a boolean only — no value, no path, nothing about WHERE it lives.
    managed: isPlatformManaged(),
    // Whether this instance is exe-backed (do-machine-mode-part2 Task 7) — the
    // tenant Secrets & Keys section hides the exe.dev SSH key row on a
    // MANAGED instance regardless of this value (self-hosted instances never hide
    // it: an admin may still be choosing exe as their sandbox provider). See
    // services/machines/provider-credentials.ts's isExeBacked for the signal.
    exeBacked: await isExeBacked(),
  })
})

// Only callers who may read Git author settings may inspect the default account identity.
app.get('/git-author-defaults', requireSecretListAccess(), async (c) => {
  const permissions = await resolvePermissions(c.get('identity') as Identity)
  if (
    !secretAccessible(permissions, 'GIT_USER_NAME', 'read') ||
    !secretAccessible(permissions, 'GIT_USER_EMAIL', 'read')
  )
    return c.json({ error: 'Forbidden' }, 403)
  c.header('Cache-Control', 'no-store')
  return c.json({ github: (await getGitHubAuthorDefaults()) ?? null })
})

/** Get a secret's decrypted value */
app.get('/:key', requireSecretKeyPermission('read'), async (c) => {
  const key = c.req.param('key')
  if (key.startsWith('__') || retiredIntegrationKey(key)) return c.json({ error: 'Secret not found' }, 404)
  if (isManagedSecretKey(key) || isHiddenHostedSecret(key)) {
    return c.json({ error: MANAGED_SECRET_ERROR }, 403)
  }
  const store = getSecretStore()
  const value = store.get(key)
  if (value === undefined) {
    return c.json({ error: 'Secret not set' }, 404)
  }
  return c.json({ key, value })
})

/** Set a secret value */
app.put('/:key', requireSecretKeyPermission('write'), async (c) => {
  const key = c.req.param('key')
  if (retiredIntegrationKey(key))
    return c.json({ error: 'Configure this provider through Integrations instead of legacy secrets.' }, 400)
  if (key.startsWith('__') || retiredIntegrationKey(key)) return c.json({ error: 'Secret not found' }, 404)
  if (isManagedSecretKey(key) || isHiddenHostedSecret(key)) {
    return c.json({ error: MANAGED_SECRET_ERROR }, 403)
  }
  const parsedBody = await parseJsonBody(c)
  if (!parsedBody.ok) {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }
  const body = parsedBody.value
  if (typeof body !== 'object' || body === null || !('value' in body) || typeof body.value !== 'string') {
    return c.json({ error: 'Secret value must be a string' }, 400)
  }
  const force = (body as { force?: unknown }).force === true
  const actor = auditActor(c.get('identity') as Identity)
  const validate = getSecretValidator(key)
  let validation: SecretValidation | undefined

  // Validate only the candidate value. Empty values retain the existing clear idiom.
  if (validate && body.value !== '') {
    try {
      validation = await validate(body.value)
    } catch {
      // Validators must not throw. Never pass a thrown object to the logger because
      // a future implementation might attach sensitive request metadata to it.
      log.error(`Secret validator crashed for key ${JSON.stringify(key)}`)
      validation = { status: 'unverified', message: 'The token could not be validated.' }
    }
    if (validation.status === 'invalid') {
      log.warn(`Rejected invalid secret save for ${JSON.stringify(key)} (actor ${actor})`)
      return c.json({ error: validation.message, validation }, 409)
    }
    if (validation.status === 'valid' && validation.warnings.length > 0 && !force) {
      log.warn(`Secret save for ${JSON.stringify(key)} needs warning confirmation (actor ${actor})`)
      return c.json(
        {
          error: `Not saved: ${validation.warnings.join(' ')} Re-submit with {"force": true} to save anyway.`,
          validation,
        },
        409
      )
    }
  }

  const store = getSecretStore()
  await store.set(key, body.value, actor)

  return c.json({ key, updated: true, ...(validation ? { validation } : {}) })
})

/** Delete a secret */
app.delete('/:key', requireSecretKeyPermission('write'), async (c) => {
  const key = c.req.param('key')
  if (key.startsWith('__') || retiredIntegrationKey(key)) return c.json({ error: 'Secret not found' }, 404)
  if (isManagedSecretKey(key) || isHiddenHostedSecret(key)) {
    return c.json({ error: MANAGED_SECRET_ERROR }, 403)
  }
  const store = getSecretStore()
  await store.delete(key)
  return c.json({ key, deleted: true })
})

export default app
