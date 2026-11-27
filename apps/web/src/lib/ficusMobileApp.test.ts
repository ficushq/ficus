import { expect, test } from 'bun:test'
import { FICUS_IOS_APP_URL, FICUS_MOBILE_URL, mobileAppInstall } from './ficusMobileApp'

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1'
const IPAD_AS_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15'
const ANDROID =
  'Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36'

test('an iPhone is sent straight to the App Store', () => {
  expect(mobileAppInstall({ userAgent: IPHONE, maxTouchPoints: 5 })).toEqual({
    url: FICUS_IOS_APP_URL,
    label: 'Get it on the App Store',
  })
  expect(FICUS_IOS_APP_URL).toBe('https://apps.apple.com/app/ficus-mobile/id6817527183')
})

test('an iPad that reports itself as a Mac is recognised by its touch screen', () => {
  expect(mobileAppInstall({ userAgent: IPAD_AS_MAC, maxTouchPoints: 5 }).url).toBe(FICUS_IOS_APP_URL)
  // A real Mac has no touch points and is not sent to the App Store.
  expect(mobileAppInstall({ userAgent: IPAD_AS_MAC, maxTouchPoints: 0 }).url).toBe(`${FICUS_MOBILE_URL}#download`)
})

test('every other device goes to the download section on ficus.sh, which lists each store', () => {
  expect(mobileAppInstall({ userAgent: ANDROID, maxTouchPoints: 5 })).toEqual({
    url: 'https://ficus.sh/mobile#download',
    label: 'Get it from ficus.sh',
  })
})
