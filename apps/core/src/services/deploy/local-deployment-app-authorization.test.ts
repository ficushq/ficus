import { describe, expect, it } from 'bun:test'
import { appOriginAuthorization } from './local-deployment-app-authorization'

const ACCESS_TOKEN = 'this-request-access-token-abcdef'
const OTHER_APP_TOKEN = 'OtherAppBrowserToken_0123456789a'
const SECRETS: Record<string, string> = {
  FICUS_PASSWORD: 'bootstrap-password',
  SANDBOX_CALLBACK_SECRET: 'sandbox-callback-secret',
  DEMO_REVIEWER_SECRET: 'demo-reviewer-secret',
}

const deps = {
  isAnyLocalDeploymentBrowserToken: async (token: string) => token === OTHER_APP_TOKEN,
  getSecret: (name: string) => SECRETS[name],
}

const forwarded = (value: string | null) => appOriginAuthorization(value, ACCESS_TOKEN, deps)
const basic = (pair: string) => `Basic ${Buffer.from(pair).toString('base64')}`

describe('appOriginAuthorization', () => {
  it("forwards the app's own credential unchanged", async () => {
    for (const value of [
      'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.sig',
      'Bearer app-token-123',
      'Token abc',
      basic('alice:app-password'),
    ]) {
      expect(await forwarded(value)).toBe(value)
    }
  })

  it('sends nothing when there is no value', async () => {
    expect(await forwarded(null)).toBeNull()
    expect(await forwarded('')).toBeNull()
    expect(await forwarded('   ')).toBeNull()
  })

  it('strips every Core-minted token kind (schedule webhook tokens included), whatever the scheme or position', async () => {
    for (const token of [
      'ficus_sess_abc',
      'ficus_agent_abc',
      'ficus_dev_abc',
      'ficus_sys_abc',
      'ficus_wst_abc',
      'ficus_wh_abc',
      `whsec_${'a1'.repeat(32)}`,
    ]) {
      expect(await forwarded(`Bearer ${token}`)).toBeNull()
      expect(await forwarded(token)).toBeNull()
      expect(await forwarded(`bearer   ${token}`)).toBeNull()
      expect(await forwarded(`Bearer app-token, Bearer ${token}`)).toBeNull()
      expect(await forwarded(basic(`user:${token}`))).toBeNull()
    }
  })

  it('strips the credential that authorized this request', async () => {
    expect(await forwarded(`Bearer ${ACCESS_TOKEN}`)).toBeNull()
    expect(await forwarded(ACCESS_TOKEN)).toBeNull()
    expect(await forwarded(basic(`x:${ACCESS_TOKEN}`))).toBeNull()
  })

  it("strips another deployment's browser access token", async () => {
    expect(await forwarded(`Bearer ${OTHER_APP_TOKEN}`)).toBeNull()
  })

  it('strips the instance secrets that authenticate to Core', async () => {
    expect(await forwarded('Bearer bootstrap-password')).toBeNull()
    expect(await forwarded('Bearer sandbox-callback-secret')).toBeNull()
    expect(await forwarded('Bearer demo-reviewer-secret')).toBeNull()
    expect(await forwarded(basic('admin:bootstrap-password'))).toBeNull()
  })

  it('ignores secrets that are not configured', async () => {
    const unset = { ...deps, getSecret: () => undefined }
    expect(await appOriginAuthorization('Bearer bootstrap-password', ACCESS_TOKEN, unset)).toBe(
      'Bearer bootstrap-password'
    )
  })
})
