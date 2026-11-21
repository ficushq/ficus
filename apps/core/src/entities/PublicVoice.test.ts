import { afterAll, expect, test } from 'bun:test'
import { eq, like } from 'drizzle-orm'
import { db, publicVoices, settings } from '../db'
import { eventEmitter } from '../lib/infra/event-emitter'
import { publicVoiceSync } from '../services/config-sync'
import { INSTANCE_DEFAULT_VOICE_SETTING_KEY, PublicVoice } from './PublicVoice'

const prefix = `pv-entity-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

afterAll(async () => {
  await PublicVoice.setInstanceDefaultId('default')
  await db.delete(publicVoices).where(like(publicVoices.id, `${prefix}%`))
})

// The API process writes voices; the worker process builds the prompts. Each keeps its own cache.
test('a voice change in the other Core process clears this process cache at once', async () => {
  await publicVoiceSync.sync()
  const chosenId = `${prefix}-chosen`
  await PublicVoice.create({ id: chosenId, name: 'Chosen', base: 'Chosen voice.' })
  const changes: unknown[] = []
  const stopWatching = eventEmitter.on('publicVoices.changed', (data) => changes.push(data))
  let deliver: ((payload: string) => void) | undefined
  const stopListening = await eventEmitter.startListening(async (_channel, callback) => {
    deliver = callback
    return async () => {}
  })
  try {
    // Every write announces itself, so the other process can drop its copy.
    await PublicVoice.setInstanceDefaultId('default')
    expect(changes).toEqual([{}])
    expect(await PublicVoice.instanceDefaultId()).toBe('default')

    // The other process chooses a default: its write reaches the database, not this cache.
    await db
      .insert(settings)
      .values({ key: INSTANCE_DEFAULT_VOICE_SETTING_KEY, value: chosenId })
      .onConflictDoUpdate({ target: settings.key, set: { value: chosenId } })
    expect(await PublicVoice.instanceDefaultId()).toBe('default')

    // Its change event arrives over the local events transport and the next read is fresh.
    deliver!(JSON.stringify({ event: 'publicVoices.changed', data: {}, source: 'peer-process' }))
    expect(await PublicVoice.instanceDefaultId()).toBe(chosenId)
  } finally {
    stopWatching()
    await stopListening()
    await db.delete(settings).where(eq(settings.key, INSTANCE_DEFAULT_VOICE_SETTING_KEY))
    PublicVoice.invalidateCache()
  }
})
