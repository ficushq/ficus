import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { randomBytes } from 'crypto'
import { db, secrets } from '../../db'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { SecretStore, getSecretStore, resetSecretStore } from '../secrets'
import { notifyOnboardingChanged, registerOnboardingEventSources, resetOnboardingEventSourcesForTest } from './events'

describe('onboarding events', () => {
  const testKey = randomBytes(32).toString('hex')
  let store: SecretStore

  beforeEach(async () => {
    process.env.FICUS_ENCRYPTION_KEY = testKey
    await db.delete(secrets)
    resetSecretStore()
    store = getSecretStore()
    await store.initialize()
    resetOnboardingEventSourcesForTest()
    eventEmitter.removeAllListeners()
  })

  afterEach(() => {
    resetOnboardingEventSourcesForTest()
    store.stopPeriodicRefresh()
    delete process.env.FICUS_ENCRYPTION_KEY
  })

  describe('notifyOnboardingChanged (leading-edge with trailing catch-up)', () => {
    test('the first call emits immediately (within a tick), not after the delay', async () => {
      const spy = mock(() => {})
      eventEmitter.on('onboarding.updated', spy)

      notifyOnboardingChanged(1000)
      // Leading-edge: no need to wait out the delay at all.
      await new Promise((r) => setTimeout(r, 0))
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy).toHaveBeenCalledWith({})
    })

    test('calls arriving during the suppression window coalesce into at most one trailing emit', async () => {
      const spy = mock(() => {})
      eventEmitter.on('onboarding.updated', spy)

      notifyOnboardingChanged(30) // leading emit, opens a 30ms suppression window
      await new Promise((r) => setTimeout(r, 0))
      expect(spy).toHaveBeenCalledTimes(1)

      // Bursts during the window must not each emit (Issue 1's 25Hz-write case).
      notifyOnboardingChanged(30)
      notifyOnboardingChanged(30)
      notifyOnboardingChanged(30)
      expect(spy).toHaveBeenCalledTimes(1) // still just the leading emit

      await new Promise((r) => setTimeout(r, 60))
      // Exactly one trailing emit for the whole burst — not zero (a suppressed
      // burst is never silently dropped) and not one-per-call.
      expect(spy).toHaveBeenCalledTimes(2)
    })

    test('a call after the window has closed emits immediately again', async () => {
      const spy = mock(() => {})
      eventEmitter.on('onboarding.updated', spy)

      notifyOnboardingChanged(20)
      await new Promise((r) => setTimeout(r, 0))
      expect(spy).toHaveBeenCalledTimes(1)

      // Let the window close with no further calls (no trailing emit expected).
      await new Promise((r) => setTimeout(r, 40))
      expect(spy).toHaveBeenCalledTimes(1)

      // A fresh call after the window is a new leading edge — immediate again.
      notifyOnboardingChanged(20)
      await new Promise((r) => setTimeout(r, 0))
      expect(spy).toHaveBeenCalledTimes(2)
    })
  })

  describe('registerOnboardingEventSources', () => {
    test('a __integration-credential:test-onboarding secret change triggers notifyOnboardingChanged', async () => {
      const spy = mock(() => {})
      eventEmitter.on('onboarding.updated', spy)
      registerOnboardingEventSources()

      await store.set('__integration-credential:test-onboarding', 'ghp_test', 'test')

      await new Promise((r) => setTimeout(r, 1400))
      expect(spy).toHaveBeenCalledTimes(1)
    }, 3000)

    test('a SLACK_BOT_TOKEN secret change triggers notifyOnboardingChanged', async () => {
      const spy = mock(() => {})
      eventEmitter.on('onboarding.updated', spy)
      registerOnboardingEventSources()

      await store.set('SLACK_BOT_TOKEN', 'xoxb-test', 'test')

      await new Promise((r) => setTimeout(r, 1400))
      expect(spy).toHaveBeenCalledTimes(1)
    }, 3000)

    test('a DISCORD_BOT_TOKEN secret change triggers notifyOnboardingChanged', async () => {
      const spy = mock(() => {})
      eventEmitter.on('onboarding.updated', spy)
      registerOnboardingEventSources()

      await store.set('DISCORD_BOT_TOKEN', 'discord-test', 'test')

      await new Promise((r) => setTimeout(r, 1400))
      expect(spy).toHaveBeenCalledTimes(1)
    }, 3000)

    test('an unrelated secret change (e.g. OPENAI_API_KEY) does NOT trigger notifyOnboardingChanged', async () => {
      const spy = mock(() => {})
      eventEmitter.on('onboarding.updated', spy)
      registerOnboardingEventSources()

      await store.set('OPENAI_API_KEY', 'sk-test', 'test')

      await new Promise((r) => setTimeout(r, 1400))
      expect(spy).not.toHaveBeenCalled()
    }, 3000)

    test('squad.created re-emits onboarding.updated', async () => {
      const spy = mock(() => {})
      eventEmitter.on('onboarding.updated', spy)
      registerOnboardingEventSources()

      eventEmitter.emit('squad.created', { squadId: 'squad-1' })

      await new Promise((r) => setTimeout(r, 1400))
      expect(spy).toHaveBeenCalledTimes(1)
    }, 3000)

    test('squad.archived re-emits onboarding.updated', async () => {
      const spy = mock(() => {})
      eventEmitter.on('onboarding.updated', spy)
      registerOnboardingEventSources()

      eventEmitter.emit('squad.archived', { squadId: 'squad-1' })

      await new Promise((r) => setTimeout(r, 1400))
      expect(spy).toHaveBeenCalledTimes(1)
    }, 3000)

    test('is idempotent — calling it twice does not double-register listeners', async () => {
      const spy = mock(() => {})
      eventEmitter.on('onboarding.updated', spy)
      registerOnboardingEventSources()
      registerOnboardingEventSources()

      eventEmitter.emit('squad.created', { squadId: 'squad-1' })

      await new Promise((r) => setTimeout(r, 1400))
      expect(spy).toHaveBeenCalledTimes(1)
    }, 3000)

    test('reset() then register() again does not double-register the eventEmitter listeners', async () => {
      const spy = mock(() => {})
      eventEmitter.on('onboarding.updated', spy)

      registerOnboardingEventSources()
      resetOnboardingEventSourcesForTest()
      registerOnboardingEventSources()

      eventEmitter.emit('squad.created', { squadId: 'squad-1' })

      await new Promise((r) => setTimeout(r, 1400))
      expect(spy).toHaveBeenCalledTimes(1)
    }, 3000)

    test('reset() then register() again does not double-register the SecretStore.onChange listener', async () => {
      const spy = mock(() => {})
      eventEmitter.on('onboarding.updated', spy)

      registerOnboardingEventSources()
      resetOnboardingEventSourcesForTest()
      registerOnboardingEventSources()

      await store.set('__integration-credential:test-onboarding', 'ghp_test', 'test')

      await new Promise((r) => setTimeout(r, 1400))
      expect(spy).toHaveBeenCalledTimes(1)
    }, 3000)
  })
})
