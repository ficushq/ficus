/** The official Ficus mobile app: its page on ficus.sh and its App Store listing. */
export const FICUS_MOBILE_URL = 'https://ficus.sh/mobile'
/** Storefront-neutral: Apple sends each visitor to their own country's listing. */
export const FICUS_IOS_APP_URL = 'https://apps.apple.com/app/ficus-mobile/id6817527183'

export interface MobileAppInstall {
  url: string
  label: string
}

/**
 * Where this device gets the app. An iPhone or iPad goes straight to the App
 * Store. Everything else goes to the download section on ficus.sh, which lists
 * every store the app is in, so a server on an older release still points
 * somewhere current when another store opens.
 */
export function mobileAppInstall(
  device: Pick<Navigator, 'userAgent' | 'maxTouchPoints'> | undefined = typeof navigator === 'undefined'
    ? undefined
    : navigator
): MobileAppInstall {
  const agent = device?.userAgent ?? ''
  // iPadOS Safari reports itself as a Mac; a touch screen tells the two apart.
  const apple = /iPhone|iPad|iPod/.test(agent) || (/Macintosh/.test(agent) && (device?.maxTouchPoints ?? 0) > 1)
  return apple
    ? { url: FICUS_IOS_APP_URL, label: 'Get it on the App Store' }
    : { url: `${FICUS_MOBILE_URL}#download`, label: 'Get it from ficus.sh' }
}
