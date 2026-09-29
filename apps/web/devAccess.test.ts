import { describe, expect, test } from 'bun:test'
import { DEV_ACCESS_COOKIE, DEV_ACCESS_HEADER, requestHasDevAccess, stripDevAccessCookie } from './devAccess'

describe('requestHasDevAccess', () => {
  test('accepts the exact token from an HttpOnly cookie or explicit client header', () => {
    expect(requestHasDevAccess({ cookie: `theme=dark; ${DEV_ACCESS_COOKIE}=secret-token` }, 'secret-token')).toBe(true)
    expect(requestHasDevAccess({ [DEV_ACCESS_HEADER]: 'secret-token' }, 'secret-token')).toBe(true)
  })

  test('the dev access cookie is ficus_dev_access and another name is not read', () => {
    expect(DEV_ACCESS_COOKIE).toBe('ficus_dev_access')
    expect(requestHasDevAccess({ cookie: 'old_dev_access=secret-token' }, 'secret-token')).toBe(false)
  })

  test('the dev access header is x-ficus-dev-access-token', () => {
    expect(DEV_ACCESS_HEADER).toBe('x-ficus-dev-access-token')
  })

  test('rejects missing, malformed, and partial tokens', () => {
    expect(requestHasDevAccess({}, 'secret-token')).toBe(false)
    expect(requestHasDevAccess({ cookie: `${DEV_ACCESS_COOKIE}=secret` }, 'secret-token')).toBe(false)
    expect(requestHasDevAccess({ cookie: `${DEV_ACCESS_COOKIE}=%` }, 'secret-token')).toBe(false)
  })
})

describe('stripDevAccessCookie', () => {
  test('removes only the local dev credential before proxying', () => {
    expect(stripDevAccessCookie(`session=abc; ${DEV_ACCESS_COOKIE}=secret-token; theme=dark`)).toBe(
      'session=abc; theme=dark'
    )
    expect(stripDevAccessCookie(`${DEV_ACCESS_COOKIE}=secret-token`)).toBeUndefined()
  })
})
