/**
 * Client-side copy of the shared vault owner handle rule
 * (`managedBigbrainOwnerSchema.handle` in packages/shared/src/managed-bigbrain.ts).
 * The server stays authoritative; this only explains a bad handle before submit.
 */
const HANDLE = /^[a-z0-9][a-z0-9._-]{0,63}$/
const RESERVED_HANDLE = 'ficus-reader'
const MAX_LENGTH = 64

/** Why the server would reject this handle, or null when it is acceptable (or still empty). */
export function bigbrainHandleProblem(handle: string): string | null {
  if (!handle || HANDLE.test(handle)) {
    return handle === RESERVED_HANDLE ? `“${RESERVED_HANDLE}” is reserved. Choose another handle.` : null
  }
  if (/[^a-z0-9._-]/.test(handle)) return 'Use only lowercase letters, numbers, “.”, “_” and “-”.'
  if (!/^[a-z0-9]/.test(handle)) return 'Start with a lowercase letter or number.'
  return `Use at most ${MAX_LENGTH} characters.`
}

export function isValidBigbrainHandle(handle: string): boolean {
  return handle !== '' && bigbrainHandleProblem(handle) === null
}

/**
 * A valid handle suggested from the signed-in user's email name (before any `+tag`), falling back to
 * their display name, or '' when neither yields one.
 */
export function suggestBigbrainHandle(user: { email?: string | null; displayName?: string | null } | undefined) {
  for (const source of [user?.email?.split('@')[0]?.split('+')[0], user?.displayName]) {
    const handle = (source ?? '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[^a-z0-9]+/, '')
      .slice(0, MAX_LENGTH)
      .replace(/[._-]+$/, '')
    if (isValidBigbrainHandle(handle)) return handle
  }
  return ''
}
