import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { createHash } from 'crypto'
import { Hono } from 'hono'
import { authRouter } from './auth'
import { identityMiddleware as authMiddleware } from '../middleware/identity'
import { db } from '../db'
import {
  agents,
  agentTokens,
  emailVerifications,
  roleAssignments,
  secrets,
  roles,
  sessions,
  squads,
  userCredentials,
  users,
} from '../db/schema'
import { eq } from 'drizzle-orm'
import { resetSecretStore } from '../services/secrets'
import {
  assignRole,
  cleanupTestRbac,
  createTestAdmin,
  createTestAgentToken,
  createTestRole,
  createTestUser,
} from '../test-utils/rbac'
import { updateAuthSettings } from '../services/auth/email'
import * as webauthn from '../services/auth/webauthn'

// ── Helpers ──────────────────────────────────────────────────────────────────

const TEST_PASSWORD = 'test-secret-password-123'

/** Build a minimal app that mirrors the real index.ts wiring order */
function buildApp() {
  const app = new Hono()

  // Unprotected (before middleware)
  app.route('/api/auth', authRouter)

  // Auth middleware
  app.use('/api/*', authMiddleware)

  // Protected routes
  app.get('/api/protected', (c) => c.json({ ok: true }))

  return app
}

function bearerHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

async function clearStoredTauPassword() {
  await db.delete(secrets).where(eq(secrets.key, 'FICUS_PASSWORD'))
  resetSecretStore()
}

async function resetAuthTestState() {
  await clearStoredTauPassword()
  await db.delete(emailVerifications)
  await db.delete(userCredentials)
  await db.delete(sessions)
  await db.delete(roleAssignments)
  await db.update(agentTokens).set({ userId: null, revokedAt: new Date() })
  await db.delete(users)
}

beforeEach(resetAuthTestState)
afterEach(resetAuthTestState)

// ── Auth Status Endpoint ─────────────────────────────────────────────────────

describe('GET /api/auth/status', () => {
  it('returns authEnabled: false when FICUS_PASSWORD is not set and no admin users', async () => {
    const original = process.env.FICUS_PASSWORD
    delete process.env.FICUS_PASSWORD

    try {
      const app = buildApp()
      const res = await app.request('/api/auth/status')

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.authEnabled).toBe(false)
      expect(body.mode).toBe('password')
      expect(body.hasUsers).toBe(false)
      expect(body.hasAdminUser).toBe(false)
    } finally {
      if (original !== undefined) process.env.FICUS_PASSWORD = original
    }
  })

  it('returns authEnabled: true when FICUS_PASSWORD is set', async () => {
    const original = process.env.FICUS_PASSWORD
    process.env.FICUS_PASSWORD = TEST_PASSWORD

    try {
      const app = buildApp()
      const res = await app.request('/api/auth/status')

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.authEnabled).toBe(true)
      expect(body.mode).toBe('password')
      expect(body.hasAdminUser).toBe(false)
    } finally {
      if (original !== undefined) process.env.FICUS_PASSWORD = original
      else delete process.env.FICUS_PASSWORD
    }
  })

  it('is accessible without authentication even when auth is enabled', async () => {
    const original = process.env.FICUS_PASSWORD
    process.env.FICUS_PASSWORD = TEST_PASSWORD

    try {
      const app = buildApp()
      // No Authorization header
      const res = await app.request('/api/auth/status')

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.authEnabled).toBe(true)
    } finally {
      if (original !== undefined) process.env.FICUS_PASSWORD = original
      else delete process.env.FICUS_PASSWORD
    }
  })
})

// canSelfRegister is the login page's only anonymous view of the signup policy:
// the allowed-domain list itself is admin-only, so /status must answer the single
// question "would POST /register/email accept SOME stranger's address?" — mirroring
// isEmailAllowed (open when requireInvite is false; otherwise only already-invited
// users and allowed domains get through).
describe('GET /api/auth/status — canSelfRegister', () => {
  afterEach(async () => {
    await updateAuthSettings({ allowedDomains: [], requireInvite: true })
    await cleanupTestRbac('status-policy')
  })

  /** canSelfRegister is unconditionally true while zero users exist, so seed one. */
  async function statusWithOneUser() {
    await createTestUser({ prefix: 'status-policy' })
    const res = await buildApp().request('/api/auth/status')
    expect(res.status).toBe(200)
    return res.json()
  }

  it('is false for the invite-only default (requireInvite, empty allowlist)', async () => {
    await updateAuthSettings({ requireInvite: true, allowedDomains: [] })
    const body = await statusWithOneUser()
    expect(body.hasUsers).toBe(true)
    expect(body.canSelfRegister).toBe(false)
  })

  it('is true in domain-allowlist mode', async () => {
    await updateAuthSettings({ requireInvite: true, allowedDomains: ['example.com'] })
    const body = await statusWithOneUser()
    expect(body.canSelfRegister).toBe(true)
  })

  it('is true when signup is open (requireInvite false)', async () => {
    await updateAuthSettings({ requireInvite: false, allowedDomains: [] })
    const body = await statusWithOneUser()
    expect(body.canSelfRegister).toBe(true)
  })

  it('never leaks the allowed-domain list to anonymous callers', async () => {
    await updateAuthSettings({ requireInvite: true, allowedDomains: ['secret-corp.example'] })
    const body = await statusWithOneUser()
    expect(JSON.stringify(body)).not.toContain('secret-corp.example')
    expect(body).not.toHaveProperty('allowedDomains')
    expect(body).not.toHaveProperty('requireInvite')
  })

  it('is true in the no-users bootstrap state even under the invite-only default', async () => {
    // First-admin creation deliberately bypasses the allowlist, so the setup flow
    // must never be suppressed by the stored policy.
    await updateAuthSettings({ requireInvite: true, allowedDomains: [] })
    const res = await buildApp().request('/api/auth/status')
    const body = await res.json()
    expect(body.hasUsers).toBe(false)
    expect(body.canSelfRegister).toBe(true)
  })
})

// ── Login Endpoint ───────────────────────────────────────────────────────────

describe('POST /api/auth/login', () => {
  let original: string | undefined

  beforeEach(() => {
    original = process.env.FICUS_PASSWORD
  })

  afterEach(() => {
    if (original !== undefined) process.env.FICUS_PASSWORD = original
    else delete process.env.FICUS_PASSWORD
  })

  it('succeeds with correct password', async () => {
    process.env.FICUS_PASSWORD = TEST_PASSWORD
    const app = buildApp()

    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: TEST_PASSWORD }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
  })

  it('returns 401 with wrong password', async () => {
    process.env.FICUS_PASSWORD = TEST_PASSWORD
    const app = buildApp()

    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'wrong-password' }),
    })

    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('Invalid password')
  })

  it('returns 401 with empty password', async () => {
    process.env.FICUS_PASSWORD = TEST_PASSWORD
    const app = buildApp()

    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: '' }),
    })

    expect(res.status).toBe(401)
  })

  it('returns 401 with missing password field', async () => {
    process.env.FICUS_PASSWORD = TEST_PASSWORD
    const app = buildApp()

    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('Invalid password')
  })

  it('succeeds without password when auth is disabled', async () => {
    delete process.env.FICUS_PASSWORD
    const app = buildApp()

    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
  })

  it('is accessible without Authorization header (login is unprotected)', async () => {
    process.env.FICUS_PASSWORD = TEST_PASSWORD
    const app = buildApp()

    // Login endpoint should be reachable without a Bearer token
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: TEST_PASSWORD }),
    })

    expect(res.status).toBe(200)
  })

  it('rejects password with different length (timing-safe)', async () => {
    process.env.FICUS_PASSWORD = TEST_PASSWORD
    const app = buildApp()

    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'short' }),
    })

    expect(res.status).toBe(401)
  })

  it('rejects password with same length but wrong content', async () => {
    process.env.FICUS_PASSWORD = 'abcdef'
    const app = buildApp()

    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'xyzxyz' }),
    })

    expect(res.status).toBe(401)
  })
})

// ── Auth Middleware ───────────────────────────────────────────────────────────

describe('authMiddleware', () => {
  let original: string | undefined

  beforeEach(() => {
    original = process.env.FICUS_PASSWORD
  })

  afterEach(() => {
    if (original !== undefined) process.env.FICUS_PASSWORD = original
    else delete process.env.FICUS_PASSWORD
  })

  describe('when auth is enabled', () => {
    beforeEach(() => {
      process.env.FICUS_PASSWORD = TEST_PASSWORD
    })

    it('allows requests with correct Bearer token', async () => {
      const app = buildApp()

      const res = await app.request('/api/protected', {
        headers: bearerHeader(TEST_PASSWORD),
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.ok).toBe(true)
    })

    it('rejects requests without Authorization header', async () => {
      const app = buildApp()

      const res = await app.request('/api/protected')

      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.error).toBe('Authentication required')
    })

    it('rejects requests with wrong token', async () => {
      const app = buildApp()

      const res = await app.request('/api/protected', {
        headers: bearerHeader('wrong-token'),
      })

      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.error).toBe('Invalid or expired token')
    })

    it('rejects requests with empty Bearer token', async () => {
      const app = buildApp()

      const res = await app.request('/api/protected', {
        headers: { Authorization: 'Bearer ' },
      })

      expect(res.status).toBe(401)
    })

    it('rejects requests with non-Bearer auth scheme', async () => {
      const app = buildApp()

      const res = await app.request('/api/protected', {
        headers: { Authorization: `Basic ${TEST_PASSWORD}` },
      })

      expect(res.status).toBe(401)
    })

    it("rejects requests with just 'Bearer' (no space+token)", async () => {
      const app = buildApp()

      const res = await app.request('/api/protected', {
        headers: { Authorization: 'Bearer' },
      })

      expect(res.status).toBe(401)
    })

    it('protects GET requests', async () => {
      const app = buildApp()

      const res = await app.request('/api/protected')
      expect(res.status).toBe(401)
    })

    it('protects POST requests', async () => {
      const app = buildApp()

      const res = await app.request('/api/protected', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: 'test' }),
      })

      expect(res.status).toBe(401)
    })

    it('protects PATCH requests', async () => {
      const app = buildApp()

      const res = await app.request('/api/protected', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: 'updated' }),
      })

      expect(res.status).toBe(401)
    })

    it('protects DELETE requests', async () => {
      const app = buildApp()

      const res = await app.request('/api/protected', {
        method: 'DELETE',
      })

      expect(res.status).toBe(401)
    })
  })

  describe('when no FICUS_PASSWORD is set', () => {
    beforeEach(() => {
      delete process.env.FICUS_PASSWORD
    })

    it('rejects requests without Authorization header (identity middleware always requires auth)', async () => {
      const app = buildApp()

      const res = await app.request('/api/protected')

      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.error).toBe('Authentication required')
    })

    it('rejects requests with unknown token when no FICUS_PASSWORD is set', async () => {
      const app = buildApp()

      const res = await app.request('/api/protected', {
        headers: bearerHeader('anything'),
      })

      expect(res.status).toBe(401)
    })

    it('rejects requests when FICUS_PASSWORD is empty string', async () => {
      process.env.FICUS_PASSWORD = ''
      const app = buildApp()

      const res = await app.request('/api/protected')

      expect(res.status).toBe(401)
    })
  })
})

// ── Route Protection Order ───────────────────────────────────────────────────

describe('route protection order', () => {
  let original: string | undefined

  beforeEach(() => {
    original = process.env.FICUS_PASSWORD
    process.env.FICUS_PASSWORD = TEST_PASSWORD
  })

  afterEach(() => {
    if (original !== undefined) process.env.FICUS_PASSWORD = original
    else delete process.env.FICUS_PASSWORD
  })

  it('auth/status is accessible without token', async () => {
    const app = buildApp()
    const res = await app.request('/api/auth/status')
    expect(res.status).toBe(200)
  })

  it('auth/login is accessible without token', async () => {
    const app = buildApp()
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: TEST_PASSWORD }),
    })
    expect(res.status).toBe(200)
  })

  it('protected routes are blocked without token', async () => {
    const app = buildApp()
    const res = await app.request('/api/protected')
    expect(res.status).toBe(401)
  })

  it('protected routes are accessible with correct token', async () => {
    const app = buildApp()
    const res = await app.request('/api/protected', {
      headers: bearerHeader(TEST_PASSWORD),
    })
    expect(res.status).toBe(200)
  })
})

// ── WebSocket Auth ───────────────────────────────────────────────────────────

describe('WebSocket auth', () => {
  let original: string | undefined

  beforeEach(() => {
    original = process.env.FICUS_PASSWORD
  })

  afterEach(() => {
    if (original !== undefined) process.env.FICUS_PASSWORD = original
    else delete process.env.FICUS_PASSWORD
  })

  // Build an app with the WS auth guard (without the actual upgradeWebSocket
  // which requires a real Bun server). We test just the guard middleware.
  function buildWsApp() {
    const app = new Hono()
    app.get('/ws', (c) => {
      const password = process.env.FICUS_PASSWORD
      if (password) {
        const token = new URL(c.req.url).searchParams.get('token')
        if (token !== password) {
          return c.json({ error: 'Unauthorized' }, 401)
        }
      }
      return c.json({ ws: 'connected' })
    })
    return app
  }

  it('allows connection without token when auth is disabled', async () => {
    delete process.env.FICUS_PASSWORD
    const app = buildWsApp()

    const res = await app.request('/ws')
    expect(res.status).toBe(200)
  })

  it('allows connection with correct token', async () => {
    process.env.FICUS_PASSWORD = TEST_PASSWORD
    const app = buildWsApp()

    const res = await app.request(`/ws?token=${TEST_PASSWORD}`)
    expect(res.status).toBe(200)
  })

  it('rejects connection without token when auth is enabled', async () => {
    process.env.FICUS_PASSWORD = TEST_PASSWORD
    const app = buildWsApp()

    const res = await app.request('/ws')
    expect(res.status).toBe(401)
  })

  it('rejects connection with wrong token', async () => {
    process.env.FICUS_PASSWORD = TEST_PASSWORD
    const app = buildWsApp()

    const res = await app.request('/ws?token=wrong')
    expect(res.status).toBe(401)
  })

  it('rejects connection with empty token', async () => {
    process.env.FICUS_PASSWORD = TEST_PASSWORD
    const app = buildWsApp()

    const res = await app.request('/ws?token=')
    expect(res.status).toBe(401)
  })

  it('handles URL-encoded token', async () => {
    const specialPassword = 'p@ss w0rd!'
    process.env.FICUS_PASSWORD = specialPassword
    const app = buildWsApp()

    const res = await app.request(`/ws?token=${encodeURIComponent(specialPassword)}`)
    expect(res.status).toBe(200)
  })
})

// ── Edge Cases ───────────────────────────────────────────────────────────────

describe('auth edge cases', () => {
  let original: string | undefined

  beforeEach(() => {
    original = process.env.FICUS_PASSWORD
  })

  afterEach(() => {
    if (original !== undefined) process.env.FICUS_PASSWORD = original
    else delete process.env.FICUS_PASSWORD
  })

  it('handles special characters in password', async () => {
    const specialPassword = 'p@$$w0rd!#%^&*(){}[]|\\:";<>?,./~`'
    process.env.FICUS_PASSWORD = specialPassword
    const app = buildApp()

    // Login with special chars
    const loginRes = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: specialPassword }),
    })
    expect(loginRes.status).toBe(200)

    // Bearer auth with special chars
    const protectedRes = await app.request('/api/protected', {
      headers: bearerHeader(specialPassword),
    })
    expect(protectedRes.status).toBe(200)
  })

  it('handles unicode password via login endpoint', async () => {
    const unicodePassword = 'pässwörd☃🔒'
    process.env.FICUS_PASSWORD = unicodePassword
    const app = buildApp()

    // Login with unicode password works (JSON body, not header)
    const loginRes = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: unicodePassword }),
    })
    expect(loginRes.status).toBe(200)

    // Wrong unicode password fails
    const wrongRes = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'passwort' }),
    })
    expect(wrongRes.status).toBe(401)
  })

  it('handles very long password', async () => {
    const longPassword = 'a'.repeat(10000)
    process.env.FICUS_PASSWORD = longPassword
    const app = buildApp()

    const res = await app.request('/api/protected', {
      headers: bearerHeader(longPassword),
    })
    expect(res.status).toBe(200)
  })

  it('password comparison is exact (no trimming)', async () => {
    process.env.FICUS_PASSWORD = 'password'
    const app = buildApp()

    // Leading space
    const res1 = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: ' password' }),
    })
    expect(res1.status).toBe(401)

    // Trailing space
    const res2 = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'password ' }),
    })
    expect(res2.status).toBe(401)
  })

  it('password comparison is case-sensitive', async () => {
    process.env.FICUS_PASSWORD = 'MyPassword'
    const app = buildApp()

    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'mypassword' }),
    })
    expect(res.status).toBe(401)
  })

  it('dynamically responds to env changes for FICUS_PASSWORD', async () => {
    // Start with a password set
    process.env.FICUS_PASSWORD = TEST_PASSWORD
    const app = buildApp()

    // Correct token works
    const res1 = await app.request('/api/protected', {
      headers: bearerHeader(TEST_PASSWORD),
    })
    expect(res1.status).toBe(200)

    // No token is rejected
    const res2 = await app.request('/api/protected')
    expect(res2.status).toBe(401)

    // Change password
    process.env.FICUS_PASSWORD = 'new-password'

    // Old password no longer works
    const res3 = await app.request('/api/protected', {
      headers: bearerHeader(TEST_PASSWORD),
    })
    expect(res3.status).toBe(401)

    // New password works
    const res4 = await app.request('/api/protected', {
      headers: bearerHeader('new-password'),
    })
    expect(res4.status).toBe(200)
  })
})

// ── Auth Settings ────────────────────────────────────────────────────────────

describe('PUT /api/auth/settings', () => {
  let cleanup: (() => Promise<void>) | undefined

  afterEach(async () => {
    if (cleanup) {
      await cleanup()
      cleanup = undefined
    }
  })

  it('updates auth settings for admin user', async () => {
    const { createTestAdmin, cleanupTestRbac } = await import('../test-utils/rbac')
    const admin = await createTestAdmin({ prefix: 'auth-put-admin' })
    cleanup = () => cleanupTestRbac('auth-put-admin')
    const app = buildApp()

    const res = await app.request('/api/auth/settings', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...bearerHeader(admin.token),
      },
      body: JSON.stringify({
        allowedDomains: ['example.com', 'test.org'],
        requireInvite: true,
      }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.allowedDomains).toEqual(['example.com', 'test.org'])
    expect(body.requireInvite).toBe(true)

    // Reset settings to defaults
    await app.request('/api/auth/settings', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...bearerHeader(admin.token),
      },
      body: JSON.stringify({
        allowedDomains: [],
        requireInvite: true,
      }),
    })
  })

  it('rejects requests without settings:write permission', async () => {
    const { createTestUser, cleanupTestRbac } = await import('../test-utils/rbac')
    const user = await createTestUser({ prefix: 'auth-put-nopriv' })
    cleanup = () => cleanupTestRbac('auth-put-nopriv')
    const app = buildApp()

    const res = await app.request('/api/auth/settings', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...bearerHeader(user.token),
      },
      body: JSON.stringify({
        allowedDomains: ['evil.com'],
      }),
    })

    expect(res.status).toBe(403)
  })
})

describe('GET /api/auth/settings', () => {
  let cleanup: (() => Promise<void>) | undefined

  afterEach(async () => {
    if (cleanup) {
      await cleanup()
      cleanup = undefined
    }
  })

  it('returns the settings to a settings:read caller', async () => {
    const admin = await createTestAdmin({ prefix: 'auth-get-admin' })
    cleanup = () => cleanupTestRbac('auth-get-admin')
    const app = buildApp()

    const res = await app.request('/api/auth/settings', { headers: bearerHeader(admin.token) })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty('allowedDomains')
    expect(body).toHaveProperty('requireInvite')
  })

  // The allowed-domain list enumerates who may walk into the instance — it is
  // operator config, not public information. Anonymous callers get canSelfRegister
  // on /status instead.
  it('rejects unauthenticated callers', async () => {
    const app = buildApp()
    const res = await app.request('/api/auth/settings')
    expect(res.status).toBe(401)
  })

  it('rejects an authenticated caller without settings:read', async () => {
    const user = await createTestUser({ prefix: 'auth-get-nopriv' })
    cleanup = () => cleanupTestRbac('auth-get-nopriv')
    const app = buildApp()

    const res = await app.request('/api/auth/settings', { headers: bearerHeader(user.token) })

    expect(res.status).toBe(403)
  })
})

// ── Password Login Disabled When Admin Users Exist ───────────────────────────

describe('POST /api/auth/login with admin users', () => {
  // Note: This test requires DB fixtures with admin users + role assignments.
  // In the test DB (clean state), no admin users exist, so password login works.
  // We verify the behavior indirectly: when no admin users, password login works.
  it('password login works when no admin users exist', async () => {
    const original = process.env.FICUS_PASSWORD
    process.env.FICUS_PASSWORD = TEST_PASSWORD
    try {
      const app = buildApp()
      const res = await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: TEST_PASSWORD }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.ok).toBe(true)
    } finally {
      if (original !== undefined) process.env.FICUS_PASSWORD = original
      else delete process.env.FICUS_PASSWORD
    }
  })
})

// ── Invite-Only Registration ─────────────────────────────────────────────────

describe('invite-only registration', () => {
  let cleanup: (() => Promise<void>) | undefined

  afterEach(async () => {
    if (cleanup) {
      await cleanup()
      cleanup = undefined
    }
  })

  it('first user can register without being invited (register/email)', async () => {
    // With a clean DB (no users), first user should be allowed
    const app = buildApp()
    const res = await app.request('/api/auth/register/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'first@example.com' }),
    })

    // Should succeed (200) — first user skips invite check
    // May fail on SES but returns ok for first user in dev mode
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.firstUser).toBe(true)
  })

  it('first user gets the code in the response when email is not configured', async () => {
    const priorFrom = process.env.SES_FROM_ADDRESS
    delete process.env.SES_FROM_ADDRESS
    try {
      const app = buildApp()
      const res = await app.request('/api/auth/register/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'bootstrap-nomail@example.com' }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.firstUser).toBe(true)
      expect(body.emailConfigured).toBe(false)
      expect(body.code).toMatch(/^\d{6}$/)
    } finally {
      if (priorFrom === undefined) delete process.env.SES_FROM_ADDRESS
      else process.env.SES_FROM_ADDRESS = priorFrom
    }
  })

  it('register/options stores displayName as the user display name for the first user', async () => {
    const { User } = await import('../entities/User')
    const email = 'first-display-name@example.com'
    const code = '123456'
    cleanup = async () => {
      const user = await User.findByEmail(email)
      await user?.delete()
      await db.delete(emailVerifications).where(eq(emailVerifications.email, email))
    }
    await db.insert(emailVerifications).values({
      email,
      code: createHash('sha256').update(code).digest('hex'),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    })

    const app = buildApp()
    const res = await app.request('/api/auth/register/options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code, displayName: 'Admin User' }),
    })

    expect(res.status).toBe(200)
    const user = await User.findByEmail(email)
    expect(user?.displayName).toBe('Admin User')
  })

  it('non-invited user gets 403 on register/email', async () => {
    const { createTestUser, cleanupTestRbac } = await import('../test-utils/rbac')
    // Create an existing user so DB is non-empty (not first user scenario)
    await createTestUser({ prefix: 'invite-blocker' })
    cleanup = () => cleanupTestRbac('invite-blocker')

    const app = buildApp()
    const res = await app.request('/api/auth/register/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'stranger@example.com' }),
    })

    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toBe('Email not allowed. Contact an admin for an invite.')
  })

  it('pre-invited user passes invite gate on register/email (not 403)', async () => {
    const { createTestUser, cleanupTestRbac } = await import('../test-utils/rbac')
    const email = `invite-ok-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`
    // Create a user (simulates admin invitation)
    await createTestUser({
      prefix: 'invite-ok',
      email,
    })
    cleanup = () => cleanupTestRbac('invite-ok')

    const app = buildApp()
    const res = await app.request('/api/auth/register/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    })

    // Should NOT get 403 — user exists, passes invite check.
    // May get 200 (email sent) or 500 (SES not configured in test) but not 403.
    expect(res.status).not.toBe(403)
  })

  it('register/options rejects non-invited user when not first user', async () => {
    const { createTestUser, cleanupTestRbac } = await import('../test-utils/rbac')
    // Create an existing user so DB is non-empty
    await createTestUser({ prefix: 'invite-opts-blocker' })
    cleanup = () => cleanupTestRbac('invite-opts-blocker')

    const app = buildApp()
    const res = await app.request('/api/auth/register/options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'noone@example.com', code: '123456' }),
    })

    // Code verification will fail first (401), but if code were valid,
    // user lookup would return 404. Let's test without code to check the flow.
    expect([401, 404]).toContain(res.status)
  })
})

// ── First-admin bootstrap gate (public-subdomain takeover defense) ────────────

describe('first-admin bootstrap gate (FICUS_PASSWORD provisioned)', () => {
  let originalPw: string | undefined
  let originalFrom: string | undefined

  beforeEach(() => {
    originalPw = process.env.FICUS_PASSWORD
    originalFrom = process.env.SES_FROM_ADDRESS
    process.env.FICUS_PASSWORD = TEST_PASSWORD
    // Force emailConfigured=false so an ungated first-user path WOULD hand back the code.
    delete process.env.SES_FROM_ADDRESS
  })

  afterEach(() => {
    if (originalPw !== undefined) process.env.FICUS_PASSWORD = originalPw
    else delete process.env.FICUS_PASSWORD
    if (originalFrom !== undefined) process.env.SES_FROM_ADDRESS = originalFrom
    else delete process.env.SES_FROM_ADDRESS
  })

  it('reports firstAdmin only for the registration that wins the admin bootstrap', async () => {
    const existingRole = await db.select().from(roles).where(eq(roles.slug, 'admin'))
    const adminRole = existingRole[0] ?? (await createTestRole({ slug: 'admin', permissions: ['*'] }))
    const verification = spyOn(webauthn, 'verifyRegResponse').mockImplementation(
      async () =>
        ({
          verified: true,
          registrationInfo: {
            credential: { id: crypto.randomUUID(), publicKey: new Uint8Array([1, 2, 3]), counter: 0 },
          },
        }) as Awaited<ReturnType<typeof webauthn.verifyRegResponse>>
    )
    try {
      const subjects = await Promise.all([createTestUser(), createTestUser()])
      const app = buildApp()
      const responses = await Promise.all(
        subjects.map((subject) =>
          app.request('/api/auth/register/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...bearerHeader(TEST_PASSWORD) },
            body: JSON.stringify({ email: subject.email, response: {} }),
          })
        )
      )
      expect(responses.map((res) => res.status)).toEqual([200, 200])
      const results = await Promise.all(responses.map((res) => res.json()))
      expect(results.filter((result) => result.firstAdmin)).toHaveLength(1)
      expect(results.filter((result) => result.firstAdmin === false)).toHaveLength(1)
      const assignments = await db.select().from(roleAssignments).where(eq(roleAssignments.roleId, adminRole.id))
      expect(assignments).toHaveLength(1)
      expect(results.find((result) => result.firstAdmin).user.id).toBe(assignments[0].subjectId)
    } finally {
      verification.mockRestore()
      if (!existingRole.length) {
        await db.delete(roleAssignments).where(eq(roleAssignments.roleId, adminRole.id))
        await db.delete(roles).where(eq(roles.id, adminRole.id))
      }
    }
  })

  it('register/email without the bootstrap session → 401 and NO code in the body', async () => {
    const app = buildApp()
    const res = await app.request('/api/auth/register/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'attacker@example.com' }),
    })
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.code).toBeUndefined()
    expect(body.error).toMatch(/bootstrap/i)
  })

  it('register/email WITH the bootstrap session → 200 with the first-user code', async () => {
    const app = buildApp()
    const res = await app.request('/api/auth/register/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...bearerHeader(TEST_PASSWORD) },
      body: JSON.stringify({ email: 'owner@example.com' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.firstUser).toBe(true)
    expect(body.code).toMatch(/^\d{6}$/)
  })

  it('register/options without the bootstrap session → 401, no user created, code not accepted', async () => {
    const { User } = await import('../entities/User')
    const email = 'gate-options@example.com'
    const code = '123456'
    await db.insert(emailVerifications).values({
      email,
      code: createHash('sha256').update(code).digest('hex'),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    })
    try {
      const app = buildApp()
      const res = await app.request('/api/auth/register/options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code, displayName: 'Intruder' }),
      })
      expect(res.status).toBe(401)
      expect((await res.json()).error).toMatch(/bootstrap/i)
      // Gate runs before user creation — no admin row was planted.
      expect(await User.findByEmail(email)).toBeNull()
    } finally {
      await db.delete(emailVerifications).where(eq(emailVerifications.email, email))
    }
  })

  it('register/options WITH the bootstrap session → creates the first user and returns options', async () => {
    const { User } = await import('../entities/User')
    const email = 'gate-options-ok@example.com'
    const code = '654321'
    await db.insert(emailVerifications).values({
      email,
      code: createHash('sha256').update(code).digest('hex'),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    })
    try {
      const app = buildApp()
      const res = await app.request('/api/auth/register/options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...bearerHeader(TEST_PASSWORD) },
        body: JSON.stringify({ email, code, displayName: 'Owner' }),
      })
      expect(res.status).toBe(200)
      expect((await res.json()).options).toBeDefined()
      expect(await User.findByEmail(email)).not.toBeNull()
    } finally {
      const user = await User.findByEmail(email)
      await user?.delete()
      await db.delete(emailVerifications).where(eq(emailVerifications.email, email))
    }
  })

  it('register/verify without the bootstrap session → 401 before any passkey handling', async () => {
    const app = buildApp()
    const res = await app.request('/api/auth/register/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'gate-verify@example.com', response: { fake: true } }),
    })
    expect(res.status).toBe(401)
    expect((await res.json()).error).toMatch(/bootstrap/i)
  })

  it('register/verify WITH the bootstrap session → passes the gate (404 missing user, not bootstrap 401)', async () => {
    const app = buildApp()
    const res = await app.request('/api/auth/register/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...bearerHeader(TEST_PASSWORD) },
      body: JSON.stringify({ email: 'nobody@example.com', response: { fake: true } }),
    })
    // Gate cleared; the flow then legitimately fails on the missing user row.
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('User not found')
  })

  it('non-first-user invite flow is NOT newly gated (existing user, no session → invite 403)', async () => {
    const { createTestUser, cleanupTestRbac } = await import('../test-utils/rbac')
    await createTestUser({ prefix: 'gate-noninvite' })
    try {
      const app = buildApp()
      const res = await app.request('/api/auth/register/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'stranger@example.com' }),
      })
      // Not the bootstrap 401 — the normal invite gate still governs non-first users.
      expect(res.status).toBe(403)
      expect((await res.json()).error).toMatch(/not allowed/i)
    } finally {
      await cleanupTestRbac('gate-noninvite')
    }
  })
})

describe('first-run stays ungated with no FICUS_PASSWORD (bare local install)', () => {
  let originalFrom: string | undefined

  beforeEach(() => {
    originalFrom = process.env.SES_FROM_ADDRESS
    delete process.env.SES_FROM_ADDRESS
    delete process.env.FICUS_PASSWORD
  })

  afterEach(() => {
    if (originalFrom !== undefined) process.env.SES_FROM_ADDRESS = originalFrom
    else delete process.env.SES_FROM_ADDRESS
  })

  it('register/email first user without any session → 200 with the code (today’s local flow)', async () => {
    const app = buildApp()
    const res = await app.request('/api/auth/register/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'local-owner@example.com' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.firstUser).toBe(true)
    expect(body.code).toMatch(/^\d{6}$/)
  })
})

describe('finishing first-admin setup from the bootstrap session', () => {
  let originalPw: string | undefined

  beforeEach(() => {
    originalPw = process.env.FICUS_PASSWORD
    process.env.FICUS_PASSWORD = TEST_PASSWORD
  })

  afterEach(() => {
    if (originalPw !== undefined) process.env.FICUS_PASSWORD = originalPw
    else delete process.env.FICUS_PASSWORD
  })

  async function validate(token: string) {
    const res = await buildApp().request('/api/auth/validate', { headers: bearerHeader(token) })
    expect(res.status).toBe(200)
    return res.json()
  }

  function mockPasskeyVerification() {
    return spyOn(webauthn, 'verifyRegResponse').mockImplementation(
      async () =>
        ({
          verified: true,
          registrationInfo: {
            credential: { id: crypto.randomUUID(), publicKey: new Uint8Array([1, 2, 3]), counter: 0 },
          },
        }) as Awaited<ReturnType<typeof webauthn.verifyRegResponse>>
    )
  }

  async function redeem(token: string, headers: Record<string, string> = {}) {
    return buildApp().request('/api/auth/register/token/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ token, response: {} }),
    })
  }

  async function roleAssignmentsOf(userId: string) {
    return db.select({ id: roleAssignments.id }).from(roleAssignments).where(eq(roleAssignments.subjectId, userId))
  }

  it('validate names the identity type, and reports nobody waiting before the first account exists', async () => {
    const body = await validate(TEST_PASSWORD)
    expect(body).toEqual({ valid: true, identityType: 'legacy', firstAdmin: { adminExists: false, accounts: [] } })
  })

  it('validate reports the account a failed first-admin ceremony left behind', async () => {
    // /register/options creates the account; the admin role only follows a verified passkey.
    const pending = await createTestUser({ prefix: 'first-admin-pending' })
    const body = await validate(TEST_PASSWORD)
    expect(body.firstAdmin).toEqual({
      adminExists: false,
      accounts: [{ id: pending.id, email: pending.email, displayName: pending.displayName }],
    })
  })

  it('validate reports only passkey-less admins once an admin row exists (restore state)', async () => {
    const admin = await createTestAdmin({ prefix: 'first-admin-restore', canonicalAdmin: true })
    await createTestUser({ prefix: 'first-admin-invitee' })
    const body = await validate(TEST_PASSWORD)
    expect(body.firstAdmin.adminExists).toBe(true)
    expect(body.firstAdmin.accounts.map((account: { id: string }) => account.id)).toEqual([admin.id])
  })

  it('validate carries no setup details for a person', async () => {
    const user = await createTestUser({ prefix: 'first-admin-person' })
    expect(await validate(user.token)).toEqual({ valid: true, identityType: 'user' })
  })

  it('the bootstrap session redeeming a registration link makes the pending account the first admin', async () => {
    const existingRole = await db.select().from(roles).where(eq(roles.slug, 'admin'))
    const adminRole = existingRole[0] ?? (await createTestRole({ slug: 'admin', permissions: ['*'] }))
    const pending = await createTestUser({ prefix: 'first-admin-finish' })
    const { issueEmailChallenge } = await import('../services/auth/email')
    const { token } = await issueEmailChallenge(pending.email)
    const verification = mockPasskeyVerification()
    try {
      const res = await redeem(token, bearerHeader(TEST_PASSWORD))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.firstAdmin).toBe(true)
      expect(body.user.id).toBe(pending.id)
      // The browser now holds a real person's session…
      expect(res.headers.get('set-cookie')).toContain(body.token)
      expect(await validate(body.token)).toEqual({ valid: true, identityType: 'user' })
      const assignments = await db
        .select({ roleId: roleAssignments.roleId })
        .from(roleAssignments)
        .where(eq(roleAssignments.subjectId, pending.id))
      expect(assignments.map((row) => row.roleId)).toEqual([adminRole.id])
      // …and the bootstrap password stops working, exactly as after /register/verify.
      const legacy = await buildApp().request('/api/protected', { headers: bearerHeader(TEST_PASSWORD) })
      expect(legacy.status).toBe(401)
    } finally {
      verification.mockRestore()
      if (!existingRole.length) {
        await db.delete(roleAssignments).where(eq(roleAssignments.roleId, adminRole.id))
        await db.delete(roles).where(eq(roles.id, adminRole.id))
      }
    }
  })

  it('a registration link redeemed without the bootstrap session grants no admin role', async () => {
    const pending = await createTestUser({ prefix: 'first-admin-elsewhere' })
    const { issueEmailChallenge } = await import('../services/auth/email')
    const { token } = await issueEmailChallenge(pending.email)
    const verification = mockPasskeyVerification()
    try {
      const res = await redeem(token)
      expect(res.status).toBe(200)
      expect((await res.json()).firstAdmin).toBe(false)
      expect(await roleAssignmentsOf(pending.id)).toEqual([])
    } finally {
      verification.mockRestore()
    }
  })

  it('a failed ceremony leaves the link usable for a retry', async () => {
    const pending = await createTestUser({ prefix: 'first-admin-retry' })
    const { issueEmailChallenge, peekVerificationToken } = await import('../services/auth/email')
    const { token } = await issueEmailChallenge(pending.email)
    const failed = spyOn(webauthn, 'verifyRegResponse').mockRejectedValueOnce(new Error('challenge expired'))
    try {
      const res = await redeem(token, bearerHeader(TEST_PASSWORD))
      expect(res.status).toBe(401)
      expect(await roleAssignmentsOf(pending.id)).toEqual([])
      expect(await peekVerificationToken(token)).not.toBeNull()
      // The bootstrap session still resolves, so the retry can still finish setup.
      expect((await validate(TEST_PASSWORD)).identityType).toBe('legacy')
    } finally {
      failed.mockRestore()
    }
  })
})

// ── Credential Management (security-path coverage) ────────────────────────────

describe('PATCH /api/auth/me', () => {
  let cleanup: (() => Promise<void>) | undefined

  afterEach(async () => {
    if (cleanup) {
      await cleanup()
      cleanup = undefined
    }
  })

  it('updates the current user display name', async () => {
    const { createTestUser, cleanupTestRbac } = await import('../test-utils/rbac')
    const user = await createTestUser({ prefix: 'me-display-name', displayName: 'Old Name' })
    cleanup = () => cleanupTestRbac('me-display-name')

    const app = buildApp()
    const res = await app.request('/api/auth/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...bearerHeader(user.token) },
      body: JSON.stringify({ displayName: 'New Name' }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.displayName).toBe('New Name')
  })

  it('stores an empty display name as null', async () => {
    const { createTestUser, cleanupTestRbac } = await import('../test-utils/rbac')
    const user = await createTestUser({ prefix: 'me-display-name-clear', displayName: 'Old Name' })
    cleanup = () => cleanupTestRbac('me-display-name-clear')

    const app = buildApp()
    const res = await app.request('/api/auth/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...bearerHeader(user.token) },
      body: JSON.stringify({ displayName: '   ' }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.displayName).toBeNull()
  })
})

// ── Credential Management (security-path coverage) ────────────────────────────

describe('GET /api/auth/me/credentials', () => {
  let cleanup: (() => Promise<void>) | undefined

  afterEach(async () => {
    if (cleanup) {
      await cleanup()
      cleanup = undefined
    }
  })

  it('response contains no publicKey and no counter fields', async () => {
    const { createTestUser, cleanupTestRbac } = await import('../test-utils/rbac')
    const user = await createTestUser({ prefix: 'cred-list-nopub' })
    cleanup = () => cleanupTestRbac('cred-list-nopub')

    // Insert a credential for the user
    await db.insert(userCredentials).values({
      userId: user.id,
      credentialId: 'cred-list-test-id-nopub',
      publicKey: 'base64pubkey==',
      counter: 42,
    })

    const app = buildApp()
    const res = await app.request('/api/auth/me/credentials', {
      headers: { Authorization: `Bearer ${user.token}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBeGreaterThanOrEqual(1)
    // Safe fields must not leak crypto material
    expect(body[0]).not.toHaveProperty('publicKey')
    expect(body[0]).not.toHaveProperty('counter')
    // Safe fields should be present
    expect(body[0]).toHaveProperty('id')
    expect(body[0]).toHaveProperty('credentialId')
    expect(body[0]).toHaveProperty('createdAt')
  })
})

describe('PATCH /api/auth/me/credentials/:id', () => {
  let cleanup: (() => Promise<void>) | undefined

  afterEach(async () => {
    if (cleanup) {
      await cleanup()
      cleanup = undefined
    }
  })

  it('renames an own passkey, and the new name round-trips in the credentials list', async () => {
    const { createTestUser, cleanupTestRbac } = await import('../test-utils/rbac')
    const user = await createTestUser({ prefix: 'cred-rename-ok' })
    cleanup = () => cleanupTestRbac('cred-rename-ok')

    const [cred] = await db
      .insert(userCredentials)
      .values({
        userId: user.id,
        credentialId: 'cred-rename-ok-key',
        publicKey: 'base64pubkey==',
        counter: 0,
        displayName: 'Passkey on Mac',
      })
      .returning()

    const app = buildApp()
    const res = await app.request(`/api/auth/me/credentials/${cred.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${user.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: '  YubiKey 5C  ' }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).displayName).toBe('YubiKey 5C')

    // The name the LIST endpoint reports is the one that matters to the UI.
    const listRes = await app.request('/api/auth/me/credentials', {
      headers: { Authorization: `Bearer ${user.token}` },
    })
    const list = await listRes.json()
    expect(list.find((cr: { id: string }) => cr.id === cred.id).displayName).toBe('YubiKey 5C')

    await db.delete(userCredentials).where(eq(userCredentials.id, cred.id))
  })

  it('returns 404 (IDOR protection) when the credential belongs to another user', async () => {
    const { createTestUser, cleanupTestRbac } = await import('../test-utils/rbac')
    const userA = await createTestUser({ prefix: 'cred-rename-idor-a' })
    const userB = await createTestUser({ prefix: 'cred-rename-idor-b' })
    cleanup = async () => {
      await cleanupTestRbac('cred-rename-idor-a')
      await cleanupTestRbac('cred-rename-idor-b')
    }

    const [credA] = await db
      .insert(userCredentials)
      .values({
        userId: userA.id,
        credentialId: 'cred-rename-idor-a-key',
        publicKey: 'base64pubkey==',
        counter: 0,
        displayName: 'Alice key',
      })
      .returning()

    const app = buildApp()
    const res = await app.request(`/api/auth/me/credentials/${credA.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${userB.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Stolen' }),
    })
    // Same rejection shape the DELETE route uses for someone else's credential.
    expect(res.status).toBe(404)

    const [after] = await db.select().from(userCredentials).where(eq(userCredentials.id, credA.id))
    expect(after.displayName).toBe('Alice key')

    await db.delete(userCredentials).where(eq(userCredentials.userId, userA.id))
  })

  it('rejects a blank, missing, non-string or over-long name without touching the row', async () => {
    const { createTestUser, cleanupTestRbac } = await import('../test-utils/rbac')
    const user = await createTestUser({ prefix: 'cred-rename-bad' })
    cleanup = () => cleanupTestRbac('cred-rename-bad')

    const [cred] = await db
      .insert(userCredentials)
      .values({
        userId: user.id,
        credentialId: 'cred-rename-bad-key',
        publicKey: 'base64pubkey==',
        counter: 0,
        displayName: 'Original',
      })
      .returning()

    const app = buildApp()
    const patch = (body: unknown) =>
      app.request(`/api/auth/me/credentials/${cred.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${user.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

    for (const body of [{}, { displayName: '' }, { displayName: '   ' }, { displayName: 42 }]) {
      expect((await patch(body)).status).toBe(400)
    }
    expect((await patch({ displayName: 'z'.repeat(65) })).status).toBe(400)

    // Every rejection left the stored name alone.
    const [after] = await db.select().from(userCredentials).where(eq(userCredentials.id, cred.id))
    expect(after.displayName).toBe('Original')

    await db.delete(userCredentials).where(eq(userCredentials.id, cred.id))
  })

  it('accepts a name exactly at the length bound', async () => {
    const { createTestUser, cleanupTestRbac } = await import('../test-utils/rbac')
    const user = await createTestUser({ prefix: 'cred-rename-bound' })
    cleanup = () => cleanupTestRbac('cred-rename-bound')

    const [cred] = await db
      .insert(userCredentials)
      .values({
        userId: user.id,
        credentialId: 'cred-rename-bound-key',
        publicKey: 'base64pubkey==',
        counter: 0,
      })
      .returning()

    const exact = 'a'.repeat(64)
    const app = buildApp()
    const res = await app.request(`/api/auth/me/credentials/${cred.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${user.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: exact }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).displayName).toBe(exact)

    await db.delete(userCredentials).where(eq(userCredentials.id, cred.id))
  })
})

describe('DELETE /api/auth/me/credentials/:id', () => {
  let cleanup: (() => Promise<void>) | undefined

  afterEach(async () => {
    if (cleanup) {
      await cleanup()
      cleanup = undefined
    }
  })

  it('returns 400 when trying to delete the last passkey', async () => {
    const { createTestUser, cleanupTestRbac } = await import('../test-utils/rbac')
    const user = await createTestUser({ prefix: 'cred-del-last' })
    cleanup = () => cleanupTestRbac('cred-del-last')

    const [cred] = await db
      .insert(userCredentials)
      .values({
        userId: user.id,
        credentialId: 'cred-del-last-only',
        publicKey: 'base64pubkey==',
        counter: 0,
      })
      .returning()

    const app = buildApp()
    const res = await app.request(`/api/auth/me/credentials/${cred.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${user.token}` },
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/only passkey/i)

    // Cleanup credential manually (user cleanup alone won't fire cascade in time)
    await db.delete(userCredentials).where(eq(userCredentials.id, cred.id))
  })

  it('returns 404 (IDOR protection) when credential belongs to another user', async () => {
    const { createTestUser, cleanupTestRbac } = await import('../test-utils/rbac')
    const userA = await createTestUser({ prefix: 'cred-idor-a' })
    const userB = await createTestUser({ prefix: 'cred-idor-b' })
    cleanup = async () => {
      await cleanupTestRbac('cred-idor-a')
      await cleanupTestRbac('cred-idor-b')
    }

    // Create a credential for user A
    const [credA] = await db
      .insert(userCredentials)
      .values({
        userId: userA.id,
        credentialId: 'cred-idor-a-key',
        publicKey: 'base64pubkey==',
        counter: 0,
      })
      .returning()

    // User B must have 2+ credentials so the "last passkey" guard doesn't fire first
    await db.insert(userCredentials).values({
      userId: userB.id,
      credentialId: 'cred-idor-b-key1',
      publicKey: 'base64pubkeyB1==',
      counter: 0,
    })
    await db.insert(userCredentials).values({
      userId: userB.id,
      credentialId: 'cred-idor-b-key2',
      publicKey: 'base64pubkeyB2==',
      counter: 0,
    })

    const app = buildApp()
    // User B tries to delete user A's credential — must get 404 (not found in B's list)
    const res = await app.request(`/api/auth/me/credentials/${credA.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${userB.token}` },
    })
    expect(res.status).toBe(404)

    // Credential still exists (wasn't deleted)
    const remaining = await db.select().from(userCredentials).where(eq(userCredentials.id, credA.id))
    expect(remaining.length).toBe(1)

    // Cleanup
    await db.delete(userCredentials).where(eq(userCredentials.userId, userA.id))
    await db.delete(userCredentials).where(eq(userCredentials.userId, userB.id))
  })

  it('succeeds (204) deleting one of several own passkeys', async () => {
    const { createTestUser, cleanupTestRbac } = await import('../test-utils/rbac')
    const user = await createTestUser({ prefix: 'cred-del-multi' })
    cleanup = () => cleanupTestRbac('cred-del-multi')

    const [cred1] = await db
      .insert(userCredentials)
      .values({
        userId: user.id,
        credentialId: 'cred-del-multi-key1',
        publicKey: 'base64pubkeyA==',
        counter: 0,
      })
      .returning()
    const [cred2] = await db
      .insert(userCredentials)
      .values({
        userId: user.id,
        credentialId: 'cred-del-multi-key2',
        publicKey: 'base64pubkeyB==',
        counter: 0,
      })
      .returning()

    const app = buildApp()
    const res = await app.request(`/api/auth/me/credentials/${cred1.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${user.token}` },
    })
    expect(res.status).toBe(204)

    // cred1 is deleted, cred2 still exists
    const afterDelete = await db.select().from(userCredentials).where(eq(userCredentials.userId, user.id))
    expect(afterDelete.map((c) => c.id)).not.toContain(cred1.id)
    expect(afterDelete.map((c) => c.id)).toContain(cred2.id)

    // Cleanup remaining credential
    await db.delete(userCredentials).where(eq(userCredentials.id, cred2.id))
  })
})

describe('POST /api/auth/login canonical admin lockout', () => {
  let cleanup: (() => Promise<void>) | undefined

  afterEach(async () => {
    if (cleanup) {
      await cleanup()
      cleanup = undefined
    }
  })

  it('returns 403 when a canonical admin holds a passkey (legacy password lockout)', async () => {
    const { createTestAdmin, createTestCredential, cleanupTestRbac } = await import('../test-utils/rbac')
    const original = process.env.FICUS_PASSWORD
    process.env.FICUS_PASSWORD = TEST_PASSWORD
    // Canonical admin (slug='admin') WITH a passkey → password auth disabled.
    const admin = await createTestAdmin({ prefix: 'login-lockout', canonicalAdmin: true })
    await createTestCredential({ userId: admin.id })
    cleanup = async () => {
      await cleanupTestRbac('login-lockout')
      if (original !== undefined) process.env.FICUS_PASSWORD = original
      else delete process.env.FICUS_PASSWORD
    }

    const app = buildApp()
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: TEST_PASSWORD }),
    })
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toMatch(/disabled/i)
  })

  it('accepts the password in the restored state (canonical admin exists, zero credentials)', async () => {
    const { createTestAdmin, cleanupTestRbac } = await import('../test-utils/rbac')
    const original = process.env.FICUS_PASSWORD
    process.env.FICUS_PASSWORD = TEST_PASSWORD
    // Restore state: admin/role rows survive, origin-bound credentials stripped.
    await createTestAdmin({ prefix: 'login-restore', canonicalAdmin: true })
    cleanup = async () => {
      await cleanupTestRbac('login-restore')
      if (original !== undefined) process.env.FICUS_PASSWORD = original
      else delete process.env.FICUS_PASSWORD
    }

    const app = buildApp()
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: TEST_PASSWORD }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })
})

describe('GET /api/auth/status password-vs-passkey mode', () => {
  let cleanup: (() => Promise<void>) | undefined

  afterEach(async () => {
    if (cleanup) {
      await cleanup()
      cleanup = undefined
    }
  })

  it('reports passkey mode once a canonical admin holds a passkey', async () => {
    const { createTestAdmin, createTestCredential, cleanupTestRbac } = await import('../test-utils/rbac')
    const admin = await createTestAdmin({ prefix: 'status-passkey', canonicalAdmin: true })
    await createTestCredential({ userId: admin.id })
    cleanup = () => cleanupTestRbac('status-passkey')

    const app = buildApp()
    const res = await app.request('/api/auth/status')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.mode).toBe('passkey')
    expect(body.hasAdminUser).toBe(true)
  })

  it('reports password mode in the restored state (canonical admin exists, zero credentials)', async () => {
    const { createTestAdmin, cleanupTestRbac } = await import('../test-utils/rbac')
    await createTestAdmin({ prefix: 'status-restore', canonicalAdmin: true })
    cleanup = () => cleanupTestRbac('status-restore')

    const app = buildApp()
    const res = await app.request('/api/auth/status')
    expect(res.status).toBe(200)
    const body = await res.json()
    // password login must still be offered even though an admin row exists…
    expect(body.mode).toBe('password')
    // …and hasAdminUser still truthfully reports the surviving admin row.
    expect(body.hasAdminUser).toBe(true)
  })
})

// ── Permissions Endpoint ────────────────────────────────────────────────────

describe('GET /api/auth/permissions', () => {
  it('includes squad-scoped role permissions only when squadId is provided', async () => {
    const prefix = `auth-perms-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const app = buildApp()
    const user = await createTestUser({ prefix })
    const role = await createTestRole({ prefix, permissions: ['agents:run'] })
    const [squad] = await db
      .insert(squads)
      .values({ name: `${prefix} Squad`, purpose: 'permissions test' })
      .returning()
    await assignRole({ userId: user.id, roleId: role.id, scope: 'squad', squadId: squad.id })

    try {
      const systemScope = await app.request('/api/auth/permissions', { headers: bearerHeader(user.token) })
      expect(systemScope.status).toBe(200)
      const systemBody = await systemScope.json()
      expect(systemBody.permissions).not.toContain('agents:run')
      expect(systemBody.identity).toEqual({ type: 'user', userId: user.id })

      const squadScope = await app.request(`/api/auth/permissions?squadId=${squad.id}`, {
        headers: bearerHeader(user.token),
      })
      expect(squadScope.status).toBe(200)
      expect((await squadScope.json()).permissions).toContain('agents:run')
    } finally {
      await db.delete(squads).where(eq(squads.id, squad.id))
    }
  })
})

// ── Introspection Endpoint ──────────────────────────────────────────────────

describe('GET /api/auth/introspect', () => {
  it('reports a consultant agent identity, mapped role, and effective squad-scoped permissions', async () => {
    const prefix = `auth-introspect-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const app = buildApp()
    const [squad] = await db
      .insert(squads)
      .values({ name: `${prefix} Squad`, purpose: 'introspection test' })
      .returning()
    const [agent] = await db.insert(agents).values({ agentTypeId: 'consultant', squadId: squad.id }).returning()
    await createTestRole({ prefix, slug: 'default-manager', permissions: ['squads:read', 'squads:update'] })
    const token = await createTestAgentToken({ agentId: agent.id, squadId: squad.id })

    try {
      const res = await app.request(`/api/auth/introspect?squadId=${squad.id}`, {
        headers: bearerHeader(token.token),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.identity).toMatchObject({ type: 'agent', agentId: agent.id, squadId: squad.id })
      expect(body.squadId).toBe(squad.id)
      expect(body.permissions).toContain('squads:update')
      expect(body.roles).toContainEqual(
        expect.objectContaining({ slug: 'default-manager', scope: 'squad', source: 'agentType' })
      )
    } finally {
      await db.delete(agents).where(eq(agents.id, agent.id))
      await db.delete(squads).where(eq(squads.id, squad.id))
      await db.delete(roles).where(eq(roles.slug, 'default-manager'))
    }
  })
})

describe('account Feed visits', () => {
  it('shares a monotonic watermark across devices without touching another account', async () => {
    const first = await createTestUser({ prefix: 'feed-first' })
    const second = await createTestUser({ prefix: 'feed-second' })
    const app = buildApp()
    const read = async (token: string) => {
      const response = await app.request('/api/auth/me/feed-visit', { headers: bearerHeader(token) })
      expect(response.status).toBe(200)
      expect(response.headers.get('Cache-Control')).toBe('no-store')
      return response.json()
    }
    const acknowledge = async (visitedAt: string) => {
      const response = await app.request('/api/auth/me/feed-visit', {
        method: 'POST',
        headers: { ...bearerHeader(first.token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ visitedAt }),
      })
      expect(response.status).toBe(200)
      return response.json()
    }
    const initial = await read(first.token)
    expect(initial.lastVisitedAt).toBeNull()
    expect(Number.isFinite(Date.parse(initial.observedAt))).toBe(true)
    await acknowledge('2026-01-02T00:00:00.000Z')
    await acknowledge('2026-01-01T00:00:00.000Z')
    expect((await read(first.token)).lastVisitedAt).toBe('2026-01-02T00:00:00.000Z')
    expect((await read(second.token)).lastVisitedAt).toBeNull()
    await acknowledge('9999-01-01T00:00:00.000Z')
    const capped = await read(first.token)
    expect(Date.parse(capped.lastVisitedAt)).toBeLessThanOrEqual(Date.parse(capped.observedAt))
  })

  it('rejects invalid visit times', async () => {
    const user = await createTestUser({ prefix: 'feed-invalid' })
    const response = await buildApp().request('/api/auth/me/feed-visit', {
      method: 'POST',
      headers: { ...bearerHeader(user.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitedAt: 'tomorrow' }),
    })
    expect(response.status).toBe(400)
  })
})

describe('passkey login verification errors', () => {
  it('returns a retryable 401 without a session cookie when device verification fails', async () => {
    const verification = spyOn(webauthn, 'verifyAuthResponse').mockRejectedValueOnce(
      new webauthn.PasskeyAuthenticationError('Passkey verification failed')
    )
    try {
      const response = await buildApp().request('/api/auth/login/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challengeKey: 'auth:test', response: { id: 'test' } }),
      })
      expect(response.status).toBe(401)
      expect(response.headers.get('set-cookie')).toBeNull()
      expect(await response.json()).toEqual({
        error: 'Passkey verification failed. Try again and complete your device’s biometric or PIN prompt.',
      })
    } finally {
      verification.mockRestore()
    }
  })
})

// Automatic grants must have the same privilege ceiling as manual assignments.
describe('sign-up policy default-role authorization', () => {
  const prefix = 'signup-role-policy'
  afterEach(async () => {
    await updateAuthSettings({ requireInvite: true, allowedDomains: [], defaultSignupRoleId: null })
    await cleanupTestRbac(prefix)
  })
  async function put(token: string, body: unknown) {
    return buildApp().request('/api/auth/settings', {
      method: 'PUT',
      headers: { ...bearerHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }
  it('persists and explicitly clears the default role', async () => {
    const admin = await createTestAdmin({ prefix })
    const selected = await createTestRole({ prefix, permissions: ['squads:read'] })
    const response = await put(admin.token, { requireInvite: false, defaultSignupRoleId: selected.id })
    expect(response.status).toBe(200)
    expect((await response.json()).defaultSignupRoleId).toBe(selected.id)
    const cleared = await put(admin.token, { defaultSignupRoleId: null })
    expect(cleared.status).toBe(200)
    expect((await cleared.json()).defaultSignupRoleId).toBeNull()
  })
  it('rejects a role with permissions the settings editor does not hold', async () => {
    const editor = await createTestUser({ prefix })
    const editorRole = await createTestRole({ prefix, permissions: ['settings:write'] })
    await assignRole({ userId: editor.id, roleId: editorRole.id, scope: 'system' })
    const elevated = await createTestRole({ prefix, permissions: ['*'] })
    expect((await put(editor.token, { requireInvite: false, defaultSignupRoleId: elevated.id })).status).toBe(403)
    // Omitting the role field must not bypass the check when broadening admission.
    await updateAuthSettings({ defaultSignupRoleId: elevated.id })
    expect((await put(editor.token, { requireInvite: false })).status).toBe(403)
    expect((await put(editor.token, { requireInvite: false, defaultSignupRoleId: null })).status).toBe(200)
  })
  it('rejects missing roles and malformed settings', async () => {
    const admin = await createTestAdmin({ prefix })
    expect((await put(admin.token, { defaultSignupRoleId: crypto.randomUUID() })).status).toBe(400)
    expect((await put(admin.token, { defaultSignupRoleId: 'admin' })).status).toBe(400)
    expect((await put(admin.token, { requireInvite: 'false' })).status).toBe(400)
  })
  it.each([false, true])('applies the default through register/options for requireInvite=%s', async (requireInvite) => {
    await createTestAdmin({ prefix })
    const selected = await createTestRole({ prefix, permissions: ['squads:read'] })
    await updateAuthSettings({ requireInvite, allowedDomains: ['example.com'], defaultSignupRoleId: selected.id })
    const email = `${prefix}-${crypto.randomUUID()}@example.com`
    const code = '654321'
    await db.insert(emailVerifications).values({
      email,
      code: createHash('sha256').update(code).digest('hex'),
      expiresAt: new Date(Date.now() + 60_000),
    })
    try {
      const response = await buildApp().request('/api/auth/register/options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code }),
      })
      expect(response.status).toBe(200)
      const [user] = await db.select().from(users).where(eq(users.email, email))
      expect(user).toBeDefined()
      const assigned = await db.select().from(roleAssignments).where(eq(roleAssignments.subjectId, user!.id))
      expect(assigned.map((r) => r.roleId)).toEqual([selected.id])
    } finally {
      await db.delete(emailVerifications).where(eq(emailVerifications.email, email))
    }
  })
  it('preserves an invited user’s role when they register through the email-code path', async () => {
    const admin = await createTestAdmin({ prefix })
    const selected = await createTestRole({ prefix, permissions: ['squads:read'] })
    await updateAuthSettings({ requireInvite: false, defaultSignupRoleId: selected.id })
    const invitee = await createTestUser({ prefix })
    const invitedRole = await createTestRole({ prefix, permissions: ['agents:read'] })
    await assignRole({ userId: invitee.id, roleId: invitedRole.id, scope: 'system' })
    const code = '654321'
    await db.insert(emailVerifications).values({
      email: invitee.email,
      code: createHash('sha256').update(code).digest('hex'),
      expiresAt: new Date(Date.now() + 60_000),
    })
    try {
      const response = await buildApp().request('/api/auth/register/options', {
        method: 'POST',
        headers: { ...bearerHeader(admin.token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: invitee.email, code }),
      })
      expect(response.status).toBe(200)
      const assigned = await db.select().from(roleAssignments).where(eq(roleAssignments.subjectId, invitee.id))
      expect(assigned.map((r) => r.roleId)).toEqual([invitedRole.id])
    } finally {
      await db.delete(emailVerifications).where(eq(emailVerifications.email, invitee.email))
    }
  })
})

describe('server capability discovery', () => {
  it('reports the same server contract before and after authentication', async () => {
    const admin = await createTestAdmin({ prefix: 'server-info' })
    try {
      const app = buildApp()
      const publicResponse = await app.request('/api/auth/status')
      const privateResponse = await app.request('/api/auth/introspect', { headers: bearerHeader(admin.token) })
      expect(publicResponse.status).toBe(200)
      expect(privateResponse.status).toBe(200)
      const publicServer = (await publicResponse.json()).server
      expect((await privateResponse.json()).server).toEqual(publicServer)
      expect(publicServer).toMatchObject({
        product: 'ficus',
        apiVersion: 1,
        capabilities: { 'workstreams.workflow-runs': 1, 'auth.signup-default-role': 1 },
      })
      expect(typeof publicServer.version).toBe('string')
      expect(Object.keys(publicServer).sort()).toEqual(['apiVersion', 'capabilities', 'product', 'revision', 'version'])
    } finally {
      await cleanupTestRbac('server-info')
    }
  })
})
