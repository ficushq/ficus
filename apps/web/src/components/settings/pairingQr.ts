import QRCode from 'qrcode'

export interface PairingCodeValue {
  code: string
  serverUrl: string
  /** ISO timestamp from the server. */
  expiresAt: string
}

export interface RenderedPairing {
  dataUrl: string
  /** ficus://pair?url=…&code=… — tap on the same phone to open the app and pair. */
  deepLink: string
  expiresAt: number
}

/** The QR the mobile app scans: JSON `{ url, code }`, plus the same-device deep link. */
export async function renderPairing(value: PairingCodeValue): Promise<RenderedPairing> {
  const dataUrl = await QRCode.toDataURL(JSON.stringify({ url: value.serverUrl, code: value.code }), {
    width: 240,
    margin: 1,
  })
  const deepLink = `ficus://pair?url=${encodeURIComponent(value.serverUrl)}&code=${encodeURIComponent(value.code)}`
  return { dataUrl, deepLink, expiresAt: new Date(value.expiresAt).getTime() }
}

// The deep link only resolves on a phone with the Ficus app installed. Offer it where the
// person can't scan their own screen: a phone browser, or any narrow or touch viewport.
const APP_LINK_QUERY = '(max-width: 639px), (pointer: coarse)'

export function canOpenFicusApp(): boolean {
  if (typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)) return true
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(APP_LINK_QUERY).matches
  )
}
