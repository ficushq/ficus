/**
 * The address a first admin gets when they sign up without an email (self-hosted and desktop
 * instances, where there is usually no mail provider anyway). `.invalid` is reserved (RFC 2606):
 * it can never receive mail, so it is safe as a unique placeholder and Core never mails it.
 */
export const PLACEHOLDER_OWNER_EMAIL = 'owner@local.ficus.invalid'

/** Whether an account's email is the no-email placeholder rather than a real address. */
export function isPlaceholderEmail(email: string | null | undefined): boolean {
  return (email ?? '').trim().toLowerCase() === PLACEHOLDER_OWNER_EMAIL
}

/** How to show an account's email: the address, or "No email" for the placeholder. */
export function accountEmailLabel(email: string | null | undefined): string {
  return isPlaceholderEmail(email) ? 'No email' : (email ?? '')
}
