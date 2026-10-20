import { eq } from 'drizzle-orm'
import { db, users } from '../../db'
import {
  describePublicAppUrl,
  normalizePublicAppUrl,
  PUBLIC_APP_URL_SETTING_KEY,
  type PublicAppUrlState,
} from '../../lib/public-app-url'
import { PUBLIC_APP_URL_FORMAT_ERROR } from '../../lib/public-app-url-format'
import { getSettingsStore, SettingValidationError, SettingVersionConflictError } from '../settings/store'
import { computePublicAppUrlChangeImpact, type PublicAppUrlChangeImpact } from './impact'

export class PublicAppUrlError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 409,
    readonly currentVersion?: string
  ) {
    super(message)
    this.name = 'PublicAppUrlError'
  }
}

export interface PublicAppUrlLastChange {
  previousValue: string | null
  newValue: string | null
  /** Display name/email for a user actor, else the raw audit actor ('system'). */
  actor: string
  source: string
  at: string
}

export interface PublicAppUrlStatus extends PublicAppUrlState {
  /** Optimistic-concurrency token to send back with PUT. */
  version: string
  lastChange: PublicAppUrlLastChange | null
  /** Mobile & Pro needs an https address. */
  mobileReady: boolean
  /** APP_BASE_PATH the web app was built with ('' at the root). */
  basePath: string
}

/** Member-safe runtime config for the web app. */
export interface PublicAppUrlRuntime {
  url: string | null
  localUrl: string | null
  source: PublicAppUrlState['source']
}

export function publicAppUrlRuntime(): PublicAppUrlRuntime {
  const state = describePublicAppUrl()
  return { url: state.url ?? null, localUrl: state.localUrl ?? null, source: state.source }
}

async function displayActor(actor: string): Promise<string> {
  const userId = actor.startsWith('user:') ? actor.slice('user:'.length) : undefined
  if (!userId) return actor
  try {
    const [row] = await db
      .select({ displayName: users.displayName, email: users.email })
      .from(users)
      .where(eq(users.id, userId))
    return row?.displayName || row?.email || actor
  } catch {
    return actor
  }
}

export async function publicAppUrlStatus(): Promise<PublicAppUrlStatus> {
  const store = getSettingsStore()
  const state = describePublicAppUrl()
  const [version, last] = await Promise.all([
    store.settingVersion(PUBLIC_APP_URL_SETTING_KEY),
    store.latestAuditEntry(PUBLIC_APP_URL_SETTING_KEY),
  ])
  return {
    ...state,
    version,
    lastChange: last
      ? {
          previousValue: last.previousValue,
          newValue: last.newValue,
          actor: await displayActor(last.actor),
          source: last.source,
          at: last.createdAt.toISOString(),
        }
      : null,
    mobileReady: state.url?.startsWith('https:') ?? false,
    basePath: (process.env.APP_BASE_PATH ?? '').trim().replace(/\/+$/, ''),
  }
}

function assertUnlocked(state: PublicAppUrlState): void {
  if (!state.locked) return
  throw new PublicAppUrlError(
    state.lockedBy === 'managed'
      ? 'This server is managed by Ficus Cloud; its public address cannot be changed here.'
      : 'The public address is set by the server environment (APP_URL). Remove it there to change it here.',
    403
  )
}

/** Normalize a proposed value (`null` = clear). Throws a 400 for an invalid one. */
function normalizeProposed(url: string | null): string | null {
  if (url === null) return null
  const normalized = normalizePublicAppUrl(url)
  if (!normalized) throw new PublicAppUrlError(PUBLIC_APP_URL_FORMAT_ERROR, 400)
  return normalized
}

/** What the effective address would become, and what that affects. Never writes. */
export function previewPublicAppUrl(url: string | null): {
  normalizedUrl: string | null
  effectiveUrl: string | null
  impact: PublicAppUrlChangeImpact
} {
  const before = describePublicAppUrl()
  const normalizedUrl = normalizeProposed(url)
  const after = describePublicAppUrl(process.env, normalizedUrl ?? undefined)
  return {
    normalizedUrl,
    effectiveUrl: after.url ?? null,
    impact: computePublicAppUrlChangeImpact(before.url, after.url),
  }
}

/** Admin write: lock check, normalization, compare-and-set and audit. */
export async function setPublicAppUrl(input: {
  url: string | null
  expectedVersion: string
  actor: string
}): Promise<PublicAppUrlStatus> {
  assertUnlocked(describePublicAppUrl())
  const normalized = normalizeProposed(input.url)
  try {
    await getSettingsStore().writeManaged(PUBLIC_APP_URL_SETTING_KEY, normalized, {
      expectedVersion: input.expectedVersion,
      actor: input.actor,
      source: 'admin-api',
    })
  } catch (error) {
    if (error instanceof SettingVersionConflictError)
      throw new PublicAppUrlError(
        'Someone else changed the public address. Review the current value and try again.',
        409,
        error.currentVersion
      )
    if (error instanceof SettingValidationError) throw new PublicAppUrlError(error.message, 400)
    throw error
  }
  return publicAppUrlStatus()
}
