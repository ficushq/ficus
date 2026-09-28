import { and, count, eq, ne, or, sql } from 'drizzle-orm'
import {
  THEME_PRESET_MAX_PER_USER,
  validateThemePresetDocument,
  type CustomThemeDocument,
  type ThemePreset,
  type ThemePresetOwner,
  type ThemePresetScope,
  type ThemePresetVisibility,
} from '@ficus/shared'
import { db, themePresets, users, type DbTx } from '../db'

type Store = typeof db | DbTx
export type ThemePresetRow = typeof themePresets.$inferSelect
/** The public-attribution columns joined alongside every preset read. */
type OwnerColumns = { displayName: string | null; email: string }

export class ThemePresetError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 422 = 400
  ) {
    super(message)
    this.name = 'ThemePresetError'
  }
}

/** The display-name-or-email fallback convention `formatRequestingUser`/chat
 * sender attribution already use elsewhere in Core — one computed name, never
 * a raw separate email field on this DTO. */
function attribution(ownerUserId: string, owner: OwnerColumns): ThemePresetOwner {
  return { id: ownerUserId, displayName: owner.displayName || owner.email }
}

export function serializeThemePreset(row: ThemePresetRow, owner: OwnerColumns): ThemePreset {
  return {
    id: row.id,
    document: row.document,
    visibility: row.visibility,
    ownerUserId: row.ownerUserId,
    owner: attribution(row.ownerUserId, owner),
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

const OWNER_JOIN_COLUMNS = { preset: themePresets, owner: { displayName: users.displayName, email: users.email } }

/** `mine`: the caller's own presets, any visibility (Phase 1 behavior, unchanged
 * ordering/shape). `shared`: every OTHER user's instance-visible preset.
 * `all`: the union of both — a caller's own preset never appears twice. */
export async function listThemePresets(
  ownerUserId: string,
  scope: ThemePresetScope = 'mine',
  store: Store = db
): Promise<{ row: ThemePresetRow; owner: OwnerColumns }[]> {
  const where =
    scope === 'mine'
      ? eq(themePresets.ownerUserId, ownerUserId)
      : scope === 'shared'
        ? and(eq(themePresets.visibility, 'instance'), ne(themePresets.ownerUserId, ownerUserId))
        : or(eq(themePresets.ownerUserId, ownerUserId), eq(themePresets.visibility, 'instance'))
  const rows = await store
    .select(OWNER_JOIN_COLUMNS)
    .from(themePresets)
    .innerJoin(users, eq(users.id, themePresets.ownerUserId))
    .where(where)
    .orderBy(themePresets.createdAt)
  return rows.map(({ preset, owner }) => ({ row: preset, owner }))
}

/** Owner-scoped read: another user's preset is indistinguishable from a missing one. */
export async function getOwnedThemePreset(
  ownerUserId: string,
  id: string,
  store: Store = db
): Promise<{ row: ThemePresetRow; owner: OwnerColumns } | null> {
  const [row] = await store
    .select(OWNER_JOIN_COLUMNS)
    .from(themePresets)
    .innerJoin(users, eq(users.id, themePresets.ownerUserId))
    .where(and(eq(themePresets.id, id), eq(themePresets.ownerUserId, ownerUserId)))
  return row ? { row: row.preset, owner: row.owner } : null
}

/** Phase 2 `GET /:id`: the caller's own preset (any visibility) OR ANY
 * instance-shared preset (the "live link" read) — another user's private
 * preset is still a 404, never distinguishable from a missing id. */
export async function getThemePresetForCaller(
  callerUserId: string,
  id: string,
  store: Store = db
): Promise<{ row: ThemePresetRow; owner: OwnerColumns } | null> {
  const [row] = await store
    .select(OWNER_JOIN_COLUMNS)
    .from(themePresets)
    .innerJoin(users, eq(users.id, themePresets.ownerUserId))
    .where(
      and(
        eq(themePresets.id, id),
        or(eq(themePresets.ownerUserId, callerUserId), eq(themePresets.visibility, 'instance'))
      )
    )
  return row ? { row: row.preset, owner: row.owner } : null
}

/** Same as `getOwnedThemePreset`, but locks the row for a revision-checked
 * mutation. The owner filter is baked into the SAME select the lock is taken
 * on — never lock first and check ownership after — so another user's row is
 * simply never selected/locked, matching the owner-only 404 (not 403)
 * contract everywhere else in this file. */
async function getOwnedThemePresetForUpdate(ownerUserId: string, id: string, tx: DbTx): Promise<ThemePresetRow | null> {
  const [row] = await tx
    .select()
    .from(themePresets)
    .where(and(eq(themePresets.id, id), eq(themePresets.ownerUserId, ownerUserId)))
    .for('update')
  return row ?? null
}

/** count-then-insert is not exclusive on its own: two concurrent creates from
 * the same owner can both read the same pre-insert count and both pass the
 * cap check (reproduced under real concurrency in the route test). A
 * per-owner transaction-scoped advisory lock serializes callers for the SAME
 * owner only (released automatically at commit/rollback, never held across
 * pool work) — other owners' creates/duplicates are unaffected. Shared by
 * `createThemePreset` and `duplicateThemePreset`: the cap applies to the
 * DUPLICATING user's own library, never the source preset's owner. */
async function insertRespectingCap(
  tx: DbTx,
  ownerUserId: string,
  document: CustomThemeDocument
): Promise<ThemePresetRow> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`theme-presets:owner:${ownerUserId}`}))`)
  const [{ value: existing }] = await tx
    .select({ value: count() })
    .from(themePresets)
    .where(eq(themePresets.ownerUserId, ownerUserId))
  if (existing >= THEME_PRESET_MAX_PER_USER)
    throw new ThemePresetError(`You can save at most ${THEME_PRESET_MAX_PER_USER} theme presets.`, 409)
  const [row] = await tx.insert(themePresets).values({ ownerUserId, document }).returning()
  return row!
}

export async function createThemePreset(ownerUserId: string, rawDocument: unknown): Promise<ThemePresetRow> {
  const result = validateThemePresetDocument(rawDocument)
  if (!result.ok) throw new ThemePresetError(result.error, 422)
  return db.transaction((tx) => insertRespectingCap(tx, ownerUserId, result.document))
}

export async function updateThemePreset(
  ownerUserId: string,
  id: string,
  revision: number,
  rawDocument: unknown
): Promise<ThemePresetRow> {
  const result = validateThemePresetDocument(rawDocument)
  if (!result.ok) throw new ThemePresetError(result.error, 422)
  return db.transaction(async (tx) => {
    const row = await getOwnedThemePresetForUpdate(ownerUserId, id, tx)
    if (!row) throw new ThemePresetError('Theme preset not found', 404)
    if (row.revision !== revision)
      throw new ThemePresetError('Theme preset changed elsewhere — reload it before saving', 409)
    const [updated] = await tx
      .update(themePresets)
      .set({ document: result.document, revision: row.revision + 1, updatedAt: new Date() })
      .where(eq(themePresets.id, id))
      .returning()
    return updated!
  })
}

export async function deleteThemePreset(ownerUserId: string, id: string, revision: number): Promise<void> {
  await db.transaction(async (tx) => {
    const row = await getOwnedThemePresetForUpdate(ownerUserId, id, tx)
    if (!row) throw new ThemePresetError('Theme preset not found', 404)
    if (row.revision !== revision)
      throw new ThemePresetError('Theme preset changed elsewhere — reload it before deleting', 409)
    await tx.delete(themePresets).where(eq(themePresets.id, id))
  })
}

/** Owner-only, revision-checked, like `updateThemePreset` — sharing/unsharing
 * never touches the document. */
export async function setThemePresetVisibility(
  ownerUserId: string,
  id: string,
  revision: number,
  visibility: ThemePresetVisibility
): Promise<ThemePresetRow> {
  return db.transaction(async (tx) => {
    const row = await getOwnedThemePresetForUpdate(ownerUserId, id, tx)
    if (!row) throw new ThemePresetError('Theme preset not found', 404)
    if (row.revision !== revision)
      throw new ThemePresetError('Theme preset changed elsewhere — reload it before saving', 409)
    const [updated] = await tx
      .update(themePresets)
      .set({ visibility, revision: row.revision + 1, updatedAt: new Date() })
      .where(eq(themePresets.id, id))
      .returning()
    return updated!
  })
}

/** Admin/operator moderation: unshare (never delete) ANY user's preset —
 * no revision check (a blunt, idempotent "take it off the shared list now",
 * not a document edit the owner could conflict with). Already private is a
 * harmless no-op (still returns the row, never bumps revision for nothing);
 * a missing id is a 404. The caller must already hold `theme-presets:moderate`
 * — this function performs no permission check of its own. */
export async function moderateUnshareThemePreset(id: string): Promise<ThemePresetRow> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(themePresets).where(eq(themePresets.id, id)).for('update')
    if (!row) throw new ThemePresetError('Theme preset not found', 404)
    if (row.visibility === 'private') return row
    const [updated] = await tx
      .update(themePresets)
      .set({ visibility: 'private', revision: row.revision + 1, updatedAt: new Date() })
      .where(eq(themePresets.id, id))
      .returning()
    return updated!
  })
}

/** Copies a document the caller can read (their own, any visibility, OR any
 * instance-shared preset) into a NEW, independent, private preset in the
 * CALLER's own library — enforcing the caller's own cap, never the source
 * owner's. The copy is always private regardless of the source's visibility. */
export async function duplicateThemePreset(callerUserId: string, id: string): Promise<ThemePresetRow> {
  const source = await getThemePresetForCaller(callerUserId, id)
  if (!source) throw new ThemePresetError('Theme preset not found', 404)
  const name = `Copy of ${source.row.document.name}`.slice(0, 40)
  const document = { ...source.row.document, name }
  const result = validateThemePresetDocument(document)
  if (!result.ok) throw new ThemePresetError(result.error, 422)
  return db.transaction((tx) => insertRespectingCap(tx, callerUserId, result.document))
}
