import { join } from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'fs'
import { beforeEach, mock } from 'bun:test'
import { sesSendMock } from './test-utils/ses-mock'
import { registerTestDatabase } from './db/test-readiness'
import { lazyTestDatabase } from './test-utils/lazy-test-database'

// Give the whole run its own Ficus home so no test can write into the developer's
// real ~/.ficus (this is what stops squad workspace stubs leaking out of tests).
// On macOS, tmpdir() is the ~45-char /var/folders/... path; with the suffixes
// the machines tunnel-manager appends (machines/ctl/owner-<pid>-<hash>.sock)
// the unix socket path exceeds the 104-byte sun_path limit and listen() fails
// ("Failed to listen at ...sock" aborting whole test files). /tmp (a symlink to
// /private/tmp) keeps the socket paths comfortably under the limit.
const tmpBase = process.platform === 'darwin' ? '/tmp' : tmpdir()
const testHomeDir = mkdtempSync(join(tmpBase, 'ficus-core-test-'))
process.env.HOME_DIR = testHomeDir

// Tear down on process exit — deliberately NOT afterAll. A preload-registered
// afterAll fires once per TEST FILE, not once per run (verified on bun 1.2.23:
// a preload afterAll + two test files → two firings; the note further down
// about beforeAll/afterAll running only once applies to a file's own hooks,
// not a preload's). Doing this in afterAll unset HOME_DIR and rm -rf'd this
// directory after the very FIRST file, so every later file ran with HOME_DIR
// undefined — silently losing the isolation this block exists to provide, and
// making `workspace.test.ts`'s "uses the process-scoped test home" assertion
// fail depending on filesystem file order (green on CI's order, red locally).
process.on('exit', () => {
  try {
    rmSync(testHomeDir, { recursive: true, force: true })
  } catch {
    // best effort — never fail a run over temp-dir cleanup
  }
})

// Pre-load pi-coding-agent module to ensure all exports are resolved before tests run
// This works around a bun issue where module exports aren't fully available in test contexts
import '@earendil-works/pi-coding-agent'

// Stash the pristine global fetch. This preload runs before any test file, so
// `globalThis.fetch` here is guaranteed to be the real one. Tests that must not
// be affected by a fetch mock leaked from an earlier file (e.g. the Ficus↔node
// conformance matrix, which does real cross-process HTTP) can restore from this.
// bun runs the whole suite in one process, and file order differs by platform,
// so a leak that hides locally can surface only in CI.
const REAL_FETCH = globalThis.fetch
;(globalThis as unknown as { __REAL_FETCH__?: typeof fetch }).__REAL_FETCH__ = REAL_FETCH

// ...and put the pristine fetch back before EVERY test, so a mock can never
// outlive the file that installed it.
//
// Without this, one file that assigns `globalThis.fetch` and forgets to restore
// it (channels/slack, channels/discord, channels/telegram all did) silently
// hands its mock to every file bun runs afterwards. The victims are whichever
// tests do real HTTP: `lib/infra/local-events.test.ts` got a bare `{ ok: true }`
// back instead of a Response, so `res.status` was `undefined` and 14 assertions
// failed with no hint of where the mock came from. bun's file order is
// filesystem order, so the same leak is invisible on macOS and reliably red on
// the CI runner.
//
// beforeEach specifically: of the four hooks a preload can register, bun runs
// beforeEach/afterEach for every test in every file, but beforeAll/afterAll
// only ONCE for the whole run (verified on 1.2.23 and on CI's pinned 1.3.8) —
// an afterAll here would restore nothing between files. bun also runs a
// preload's beforeEach BEFORE the test file's own, so a file that installs its
// mock in its own beforeEach or inside the test body still sees it.
beforeEach(() => {
  if (globalThis.fetch !== REAL_FETCH) globalThis.fetch = REAL_FETCH
})

// Mock AWS SES process-wide so no test ever hits real AWS.
//
// `email.ts` constructs `new SESClient()` at module load, which happens as soon
// as any test file imports the auth router chain (e.g. routes/auth.test.ts).
// Bun's `mock.module` can only intercept a module that has NOT yet been resolved,
// so a per-file mock in email.test.ts is defeated whenever another file imports
// the real SDK first, and a later override cannot replace an already-constructed
// client instance. Registering the mock here in the preload guarantees the SDK is
// mocked before any test file loads it. `SESClient.send` delegates to a shared
// singleton spy (`sesSendMock`) so tests (email.test.ts) can clear it, override
// its behavior, and assert on it regardless of construction order.
mock.module('@aws-sdk/client-ses', () => ({
  SESClient: class {
    send(command: unknown) {
      return sesSendMock(command)
    }
  },
  SendEmailCommand: class {
    constructor(public input: unknown) {}
  },
}))

// Mark test mode. SecretStore treats the shared test process as sterile by
// default: inherited environment credentials are neither read nor migrated.
// Individual tests must opt in with generated, test-owned keys through the
// SecretStore constructor rather than relaxing this process-wide policy.
process.env.FICUS_TEST_MODE = '1'
process.env.FICUS_TEST_SECRET_ENV_POLICY = 'sterile'
process.env.FICUS_ENCRYPTION_KEY = randomBytes(32).toString('hex')
delete process.env.FICUS_MANAGED
delete process.env.FICUS_MANAGED_SECRET_KEYS
process.env.NODE_ENV = 'test'
// FICUS_SANDBOX_RUNTIME is mandatory and explicit in production (no default, no
// auto-detection), so the suite must name one too: tests default to the
// docker-socket path. K8s/vm/host tests set their own value (and restore it).
process.env.FICUS_SANDBOX_RUNTIME = 'docker-socket'

// Disable logger colors, timestamps, and prefix padding for stable test assertions.
process.env.NO_COLOR = '1'
process.env.LOG_TIMESTAMPS = 'false'
process.env.LOG_PREFIX_WIDTH = '0'

// Capture the caller's external test DSN before tests mutate environment. Until
// readiness, never let an accidental raw client fall back to localhost:5432.
const externalDatabaseUrl = process.env.DATABASE_URL
process.env.DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:1/ficus_test'
registerTestDatabase(
  lazyTestDatabase(async () => {
    try {
      const { setupTestDatabase } = await import('./test-db-setup')
      await setupTestDatabase(externalDatabaseUrl)
    } catch (error) {
      // Bun can continue after a failed module/preload. Never run DB tests against
      // partial schema or after refused admission; EXIT also releases ownership.
      console.error(error instanceof Error ? error.message : 'Test database setup failed')
      process.exit(1)
    }
  })
)
