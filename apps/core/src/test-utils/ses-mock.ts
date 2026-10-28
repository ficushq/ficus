import { mock } from 'bun:test'

/**
 * Shared AWS SES mock for tests.
 *
 * `email.ts` constructs `new SESClient()` at module load. As soon as any test
 * file imports the auth router chain, the real '@aws-sdk/client-ses' is resolved
 * and the SES client is constructed and cached. Bun's `mock.module` can only
 * intercept a module that has not been resolved yet, so a per-file mock declared
 * in `email.test.ts` is silently defeated whenever another file loads the SDK
 * first (e.g. `routes/auth.test.ts`), and any later override cannot replace an
 * already-constructed client instance.
 *
 * To make the mock robust and order-independent, this module exposes a single
 * shared `send` spy. `test-setup.ts` (the preload) registers a `mock.module`
 * whose `SESClient.send` *delegates* to this spy at call time. Because the spy is
 * a module-level singleton resolved on each call, tests can clear/override its
 * behavior (and assert on it) regardless of when the SES client was constructed.
 */
export const sesSendMock = mock(async (_command?: unknown): Promise<{ MessageId: string }> => ({
  MessageId: 'test-message-id',
}))
