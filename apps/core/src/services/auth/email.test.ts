import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { createHash } from 'crypto'

// '@aws-sdk/client-ses' is mocked process-wide in the test preload
// (src/test-setup.ts), whose SESClient.send delegates to this shared spy. Using
// the shared spy (rather than a per-file mock.module) keeps the mock effective
// regardless of which test file first loads the SES SDK — a per-file mock is
// defeated when another file imports the real SDK before this one.
import { sesSendMock as mockSend } from '../../test-utils/ses-mock'

const {
  sendVerificationEmail,
  verifyEmailCode,
  isEmailAllowed,
  isEmailConfigured,
  getAuthSettings,
  updateAuthSettings,
  buildVerificationMessage,
  buildInviteMessage,
  buildPasskeyRecoveryMessage,
  instanceIdentity,
  formatCodeLifetime,
  DEFAULT_VERIFICATION_TTL_MS,
  INVITE_CHALLENGE_TTL_MS,
} = await import('./email')

// ── Helpers ───────────────────────────────────────────────────────────────────
function sha256(code: string) {
  return createHash('sha256').update(code).digest('hex')
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('sendVerificationEmail', () => {
  const priorFrom = process.env.SES_FROM_ADDRESS
  beforeEach(() => {
    mockSend.mockClear()
    process.env.SES_FROM_ADDRESS = 'noreply@test.local' // email configured → SES path
  })
  afterEach(() => {
    if (priorFrom === undefined) delete process.env.SES_FROM_ADDRESS
    else process.env.SES_FROM_ADDRESS = priorFrom
  })

  it('returns a 6-digit code', async () => {
    const code = await sendVerificationEmail('test@example.com')
    expect(code).toMatch(/^\d{6}$/)
  })

  it('calls SES send once', async () => {
    await sendVerificationEmail('test@example.com')
    expect(mockSend).toHaveBeenCalledTimes(1)
  })

  it('normalises email to lowercase', async () => {
    const code = await sendVerificationEmail('TEST@EXAMPLE.COM')
    expect(code).toMatch(/^\d{6}$/)
  })

  it('propagates SES send failure', async () => {
    mockSend.mockRejectedValueOnce(new Error('SES error'))
    await expect(sendVerificationEmail('fail@example.com')).rejects.toThrow('SES error')
  })
})

describe('verification email names the instance', () => {
  const priorFrom = process.env.SES_FROM_ADDRESS
  const priorAppUrl = process.env.APP_URL

  beforeEach(() => {
    mockSend.mockClear()
    process.env.SES_FROM_ADDRESS = 'noreply@test.local'
  })
  afterEach(() => {
    if (priorFrom === undefined) delete process.env.SES_FROM_ADDRESS
    else process.env.SES_FROM_ADDRESS = priorFrom
    if (priorAppUrl === undefined) delete process.env.APP_URL
    else process.env.APP_URL = priorAppUrl
  })

  /** The SendEmailCommand the mocked SES client received (test-setup's stub keeps `input`). */
  function lastSentMessage() {
    const command = mockSend.mock.calls[0]?.[0] as {
      input: { Message: { Subject: { Data: string }; Body: { Text: { Data: string }; Html: { Data: string } } } }
    }
    return command.input.Message
  }

  it('puts the instance host in the subject and its URL in both bodies', async () => {
    process.env.APP_URL = 'https://demo.ficus.sh'
    await sendVerificationEmail('who@example.com')
    const message = lastSentMessage()
    expect(message.Subject.Data).toBe('Your Ficus verification code for demo.ficus.sh')
    expect(message.Body.Text.Data).toContain('https://demo.ficus.sh')
    expect(message.Body.Html.Data).toContain('https://demo.ficus.sh')
  })

  it('names the instance URL exactly once in the text body (not spammy)', async () => {
    process.env.APP_URL = 'https://demo.ficus.sh'
    await sendVerificationEmail('who@example.com')
    const occurrences = lastSentMessage().Body.Text.Data.split('https://demo.ficus.sh').length - 1
    expect(occurrences).toBe(1)
  })

  it('degrades to the instance-less wording when APP_URL is unset', async () => {
    delete process.env.APP_URL
    await sendVerificationEmail('who@example.com')
    const message = lastSentMessage()
    expect(message.Subject.Data).toBe('Ficus — Verify your email')
    expect(message.Subject.Data).not.toContain('undefined')
    expect(message.Body.Text.Data).not.toContain('undefined')
    expect(message.Body.Html.Data).not.toContain('undefined')
    expect(message.Body.Text.Data).not.toContain('instance at')
  })

  it('degrades when APP_URL is unparseable rather than printing garbage', async () => {
    process.env.APP_URL = 'not a url'
    await sendVerificationEmail('who@example.com')
    expect(lastSentMessage().Subject.Data).toBe('Ficus — Verify your email')
  })

  it('instanceIdentity strips a trailing slash and reports the bare host', () => {
    process.env.APP_URL = 'https://demo.ficus.sh/'
    expect(instanceIdentity()).toEqual({ url: 'https://demo.ficus.sh', host: 'demo.ficus.sh' })
    process.env.APP_URL = 'https://home.example.com:8443/tau'
    expect(instanceIdentity()).toEqual({ url: 'https://home.example.com:8443/tau', host: 'home.example.com:8443' })
    delete process.env.APP_URL
    expect(instanceIdentity()).toBeNull()
  })

  // PR #682 de-hard-wrapped these templates on purpose: mail clients wrap to the
  // viewport, so a manual break mid-sentence wraps AGAIN on a phone. Every
  // non-empty line must therefore be a whole paragraph, blank-line separated.
  it('keeps the text body free of hard wraps inside sentences', () => {
    for (const instance of [{ url: 'https://demo.ficus.sh', host: 'demo.ficus.sh' }, null]) {
      for (const ttlMs of [DEFAULT_VERIFICATION_TTL_MS, 7 * 24 * 60 * 60 * 1000]) {
        const lines = buildVerificationMessage('123456', instance, ttlMs).Body.Text.Data.split('\n')
        for (const line of lines) {
          if (line === '') continue
          // A whole paragraph ends in terminal punctuation (or the bare code).
          expect(line).toMatch(/(\.|\d)$/)
        }
        // Blank-line separated: no two adjacent non-empty lines (= a wrapped paragraph).
        for (let i = 1; i < lines.length; i++) {
          expect(lines[i] !== '' && lines[i - 1] !== '').toBe(false)
        }
      }
    }
  })
})

// The expiry sentence used to be hardcoded "15 minutes" while callers passed
// their own ttlMs — an invite mailed a 7-day code that claimed to die in 15
// minutes. The wording must be derived from the TTL the code was issued with.
describe('verification email quotes the real code lifetime', () => {
  const priorFrom = process.env.SES_FROM_ADDRESS
  const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000

  beforeEach(() => {
    mockSend.mockClear()
    process.env.SES_FROM_ADDRESS = 'noreply@test.local'
  })
  afterEach(() => {
    if (priorFrom === undefined) delete process.env.SES_FROM_ADDRESS
    else process.env.SES_FROM_ADDRESS = priorFrom
  })

  function lastSentBodies() {
    const command = mockSend.mock.calls[0]?.[0] as {
      input: { Message: { Body: { Text: { Data: string }; Html: { Data: string } } } }
    }
    return command.input.Message.Body
  }

  it('formats a lifetime in the coarsest exact unit', () => {
    expect(formatCodeLifetime(60_000)).toBe('1 minute')
    expect(formatCodeLifetime(DEFAULT_VERIFICATION_TTL_MS)).toBe('15 minutes')
    expect(formatCodeLifetime(60 * 60_000)).toBe('1 hour')
    expect(formatCodeLifetime(6 * 60 * 60_000)).toBe('6 hours')
    // Under two days reads better in hours than as a rounded day count.
    expect(formatCodeLifetime(24 * 60 * 60_000)).toBe('24 hours')
    expect(formatCodeLifetime(2 * 24 * 60 * 60_000)).toBe('2 days')
    expect(formatCodeLifetime(INVITE_TTL_MS)).toBe('7 days')
  })

  it('says 15 minutes for the default self-serve code', async () => {
    await sendVerificationEmail('short@example.com')
    const body = lastSentBodies()
    expect(body.Text.Data).toContain('This code expires in 15 minutes.')
    expect(body.Html.Data).toContain('This code expires in 15 minutes.')
  })

  it('says 7 days for an invite code issued with the long TTL', async () => {
    await sendVerificationEmail('invited@example.com', { ttlMs: INVITE_TTL_MS })
    const body = lastSentBodies()
    expect(body.Text.Data).toContain('This code expires in 7 days.')
    expect(body.Html.Data).toContain('This code expires in 7 days.')
    expect(body.Text.Data).not.toContain('15 minutes')
    expect(body.Html.Data).not.toContain('15 minutes')
  })
})

describe('email-optional mode (no SES configured)', () => {
  const priorFrom = process.env.SES_FROM_ADDRESS
  beforeEach(() => {
    mockSend.mockClear()
    delete process.env.SES_FROM_ADDRESS
  })
  afterEach(() => {
    if (priorFrom === undefined) delete process.env.SES_FROM_ADDRESS
    else process.env.SES_FROM_ADDRESS = priorFrom
  })

  it('isEmailConfigured tracks SES_FROM_ADDRESS', () => {
    expect(isEmailConfigured()).toBe(false)
    process.env.SES_FROM_ADDRESS = 'sender@example.com'
    expect(isEmailConfigured()).toBe(true)
    delete process.env.SES_FROM_ADDRESS
    expect(isEmailConfigured()).toBe(false)
  })

  it('returns a verifiable code without calling SES', async () => {
    const email = 'no-email@example.com'
    const code = await sendVerificationEmail(email)
    expect(code).toMatch(/^\d{6}$/)
    expect(mockSend).not.toHaveBeenCalled()
    expect(await verifyEmailCode(email, code)).toBe(true)
  })
})

describe('verifyEmailCode', () => {
  beforeEach(() => {
    mockSend.mockClear()
  })

  it('returns true for correct code within TTL', async () => {
    const email = 'verify-ok@example.com'
    const code = await sendVerificationEmail(email)
    const result = await verifyEmailCode(email, code)
    expect(result).toBe(true)
  })

  it('returns false for wrong code', async () => {
    const email = 'verify-wrong@example.com'
    await sendVerificationEmail(email)
    const result = await verifyEmailCode(email, '000000')
    expect(result).toBe(false)
  })

  it('returns false for unknown email', async () => {
    const result = await verifyEmailCode('nobody@example.com', '123456')
    expect(result).toBe(false)
  })

  it('is single-use — second verify call returns false', async () => {
    const email = 'single-use@example.com'
    const code = await sendVerificationEmail(email)
    await verifyEmailCode(email, code)
    const second = await verifyEmailCode(email, code)
    expect(second).toBe(false)
  })

  it('is case-insensitive on email', async () => {
    const code = await sendVerificationEmail('MixedCase@example.com')
    const result = await verifyEmailCode('mixedcase@example.com', code)
    expect(result).toBe(true)
  })

  it('locks the code after too many wrong attempts (anti-brute-force)', async () => {
    const email = 'bruteforce@example.com'
    const code = await sendVerificationEmail(email)
    // MAX_VERIFY_ATTEMPTS (5) wrong guesses.
    for (let i = 0; i < 5; i++) {
      expect(await verifyEmailCode(email, '000000')).toBe(false)
    }
    // The correct code must now fail — the code is burned. (Before the fix, no
    // counter existed, so the correct code would still succeed.)
    expect(await verifyEmailCode(email, code)).toBe(false)
  })

  it('is single-use under concurrency (only one of two parallel verifies wins)', async () => {
    const email = 'concurrent-use@example.com'
    const code = await sendVerificationEmail(email)
    const [a, b] = await Promise.all([verifyEmailCode(email, code), verifyEmailCode(email, code)])
    expect([a, b].filter(Boolean)).toHaveLength(1)
  })
})

describe('isEmailAllowed', () => {
  afterEach(async () => {
    // Reset settings to requireInvite: true, empty allowedDomains
    await updateAuthSettings({ allowedDomains: [], requireInvite: true })
  })

  it('allows any email when requireInvite is false', async () => {
    await updateAuthSettings({ requireInvite: false })
    const result = await isEmailAllowed('anyone@random.org')
    expect(result).toBe(true)
  })

  it('blocks unknown email when requireInvite is true', async () => {
    await updateAuthSettings({ requireInvite: true, allowedDomains: [] })
    const result = await isEmailAllowed('stranger@example.com')
    expect(result).toBe(false)
  })

  it('allows email when domain is in allowedDomains', async () => {
    await updateAuthSettings({ requireInvite: true, allowedDomains: ['example.com'] })
    const result = await isEmailAllowed('user@example.com')
    expect(result).toBe(true)
  })

  it('domain match is case-insensitive', async () => {
    await updateAuthSettings({ requireInvite: true, allowedDomains: ['Example.com'] })
    const result = await isEmailAllowed('user@EXAMPLE.COM')
    expect(result).toBe(true)
  })
})

// ── Invite / recovery mail: the link is the ONLY instruction ──────────────────
//
// Regression guard for a dead-end instruction. The invite mail used to tell the
// reader to "go to the sign-in page, choose Create account and enter this code",
// but on an invite-only instance with no allowed domains the login page reports
// canSelfRegister:false and hides that affordance entirely — so the code had
// nowhere to be typed. The mail must never instruct someone to do something the
// UI won't let them do.

describe('invite email is link-only', () => {
  const link = 'https://demo.ficus.sh/register?token=abc123'

  function bodies() {
    const message = buildInviteMessage(link, null, INVITE_CHALLENGE_TTL_MS)
    return { text: message.Body.Text.Data, html: message.Body.Html.Data }
  }

  it('never tells the reader to enter a code on the sign-in page', () => {
    const { text, html } = bodies()
    for (const body of [text, html]) {
      expect(body).not.toContain('Create account')
      expect(body).not.toContain('sign-in page')
      expect(body).not.toMatch(/enter this code/i)
      expect(body).not.toMatch(/another device\?/i)
    }
  })

  it('carries no 6-digit code at all', () => {
    const { text, html } = bodies()
    // The challenge row still HAS a code (it is just no longer advertised), so the
    // guard is that none of it reaches the reader. In the text body that is simply
    // "no bare 6-digit run"; the HTML body is checked for the big letter-spaced
    // block the code used to be rendered in (a raw digit scan there would trip over
    // hex colours like #111827).
    expect(text).not.toMatch(/\b\d{6}\b/)
    expect(html).not.toContain('font-size:32px')
    expect(html).not.toContain('letter-spacing:4px')
  })

  it('still gives the link, and says it works cross-device', () => {
    const { text, html } = bodies()
    expect(text).toContain(link)
    expect(html).toContain(link)
    for (const body of [text, html]) {
      expect(body).toContain('works on any device')
    }
    expect(text).toContain('This invitation expires in 7 days.')
  })

  it('keeps the plain-text style: one paragraph per line, no hard wraps', () => {
    const { text } = bodies()
    // Every non-blank line is a whole paragraph — no sentence is broken across lines.
    for (const line of text.split('\n')) {
      expect(line).not.toMatch(/^\s+/)
    }
    expect(text).toContain('\n\n')
  })
})

describe('passkey-recovery email is link-only too', () => {
  it('advertises no code and no sign-in-page code entry', () => {
    const message = buildPasskeyRecoveryMessage('https://demo.ficus.sh/register?token=xyz', null, 3600000)
    const text = message.Body.Text.Data
    const html = message.Body.Html.Data
    for (const body of [text, html]) {
      expect(body).not.toMatch(/enter this code/i)
    }
    expect(text).not.toMatch(/\b\d{6}\b/)
    expect(html).not.toContain('letter-spacing:4px')
  })
})

describe('email copy names Ficus', () => {
  const instance = { host: 'demo.example.com', url: 'https://demo.example.com' }
  const link = 'https://demo.example.com/register?token=abc123'

  it('invite subject and bodies', () => {
    const message = buildInviteMessage(link, instance, INVITE_CHALLENGE_TTL_MS)
    expect(message.Subject.Data).toBe('You have been invited to Ficus at demo.example.com')
    expect(message.Body.Text.Data).toContain('You have been invited to the Ficus instance at https://demo.example.com.')
    expect(buildInviteMessage(link, null, INVITE_CHALLENGE_TTL_MS).Subject.Data).toBe('Ficus — You have been invited')
    expect(buildInviteMessage(link, null, INVITE_CHALLENGE_TTL_MS).Body.Text.Data).toContain(
      'You have been invited to join Ficus.'
    )
  })

  it('passkey-recovery subject and bodies', () => {
    const message = buildPasskeyRecoveryMessage(link, instance, 3600000)
    expect(message.Subject.Data).toBe('Register a new passkey for Ficus at demo.example.com')
    expect(message.Body.Text.Data).toContain('on the Ficus instance at https://demo.example.com.')
    expect(buildPasskeyRecoveryMessage(link, null, 3600000).Subject.Data).toBe('Ficus — Register a new passkey')
  })

  it('verification bodies', () => {
    const message = buildVerificationMessage('123456', instance, DEFAULT_VERIFICATION_TTL_MS)
    expect(message.Body.Text.Data).toContain('Your Ficus verification code is: 123456')
    expect(message.Body.Html.Data).toContain('This code is for the Ficus instance at https://demo.example.com.')
  })
})
