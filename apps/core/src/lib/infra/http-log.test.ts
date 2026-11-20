import { describe, expect, test } from 'bun:test'
import { redactHttpLogCredentials } from './http-log'

const FLOW = '11111111-1111-4111-8111-111111111111'
const HANDLE = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ'

describe('redactHttpLogCredentials', () => {
  test('hosted broker callback lines keep the path and status but never the flow or redemption handle', () => {
    const line = `--> GET /settings/integrations/oauth/callback?flow=${FLOW}&handle=${HANDLE}&status=ok 200 2ms`
    const redacted = redactHttpLogCredentials(line)
    expect(redacted).toBe(
      '--> GET /settings/integrations/oauth/callback?flow=[REDACTED]&handle=[REDACTED]&status=ok 200 2ms'
    )
    expect(redacted).not.toContain(HANDLE)
    expect(redacted).not.toContain(FLOW)
  })

  test('self-hosted callback lines never keep the authorization code or state', () => {
    const line = `--> GET /settings/integrations/oauth/callback/linear?code=secret-code&state=${HANDLE} 200 1ms`
    expect(redactHttpLogCredentials(line)).toBe(
      '--> GET /settings/integrations/oauth/callback/linear?code=[REDACTED]&state=[REDACTED] 200 1ms'
    )
  })

  test('existing credentials, signed image URLs and OAuth token names stay redacted', () => {
    expect(redactHttpLogCredentials('--> GET /ws?token=abc&ticket=def 101 1ms')).toBe(
      '--> GET /ws?token=[REDACTED]&ticket=[REDACTED] 101 1ms'
    )
    expect(redactHttpLogCredentials('--> GET /api/images/x?exp=123&sig=abcdef 200 1ms')).toBe(
      '--> GET /api/images/x?exp=123&sig=[REDACTED] 200 1ms'
    )
    expect(redactHttpLogCredentials('<-- GET /x?Access_Token=a&refresh_token=b&id_token=c&client_secret=d')).toBe(
      '<-- GET /x?Access_Token=[REDACTED]&refresh_token=[REDACTED]&id_token=[REDACTED]&client_secret=[REDACTED]'
    )
  })

  test('ordinary parameters, including ones that merely end in a sensitive name, are left alone', () => {
    const line = '--> GET /api/feed?limit=20&cursor=abc&postcode=1&status=ok 200 3ms'
    expect(redactHttpLogCredentials(line)).toBe(line)
  })
})
