/**
 * The CSRF header a first-party browser client must send on every
 * cookie-authenticated mutation (any value; its presence is the proof, since a
 * cross-site page cannot set a custom header without a CORS preflight). Core's
 * CSRF middleware checks it and its CORS allow-list admits it.
 */
export const CSRF_HEADER = 'x-ficus-csrf'
