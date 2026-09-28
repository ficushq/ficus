import { describe, expect, test } from 'bun:test'
import { FICUS_DISCORD_COMMANDS, FICUS_DISCORD_DM_COMMANDS } from '@ficus/shared/discord-commands'
import type { ChannelConnectionState } from './connections'
import { ChannelLifecycle } from './lifecycle'

type State = ChannelConnectionState | undefined

function harness(initial: { telegram?: State; discord?: State } = {}) {
  const states: { telegram?: State; discord?: State } = { ...initial }
  const calls: { url: string; method: string; body?: unknown; auth?: string }[] = []
  let failing = false
  let now = 1_000_000
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: new Headers(init?.headers).get('authorization') ?? undefined,
    })
    if (failing) return new Response('{"ok":false,"description":"down"}', { status: 502 })
    if (url.includes('api.telegram.org')) return Response.json({ ok: true, result: true })
    return Response.json([])
  }) as typeof fetch
  const discordChanges: (string | undefined)[] = []
  const lifecycle = new ChannelLifecycle({
    connections: {
      get: ((provider: 'telegram' | 'discord' | 'slack') => states[provider as 'telegram' | 'discord']) as never,
      webhookUrl: (provider) => `https://tau.example.test/api/webhooks/channels/${provider}`,
    },
    fetch: fetchImpl,
    now: () => now,
    onDiscordChange: (state) => void discordChanges.push(state?.revision),
  })
  return {
    lifecycle,
    calls,
    states,
    discordChanges,
    setFailing: (value: boolean) => (failing = value),
    advance: (ms: number) => (now += ms),
  }
}

const telegram = (revision: string, botToken = '111:tok'): ChannelConnectionState<'telegram'> => ({
  provider: 'telegram',
  id: 'c-telegram',
  revision,
  source: 'connection',
  connectionEnabled: true,
  authState: 'authenticated',
  healthState: 'healthy',
  lastErrorCode: null,
  configuration: { version: 1, botId: '111' },
  credential: { botToken, webhookSecret: 'secret-1' },
  authority: 'local',
})

const discord = (revision: string, guildId?: string): ChannelConnectionState<'discord'> => ({
  provider: 'discord',
  id: 'c-discord',
  revision,
  source: 'connection',
  connectionEnabled: true,
  authState: 'authenticated',
  healthState: 'healthy',
  lastErrorCode: null,
  configuration: { version: 1, applicationId: 'app-1', publicKey: 'pk', ...(guildId ? { guildId } : {}) },
  credential: { botToken: 'bot-tok' },
  authority: 'local',
})

describe('ChannelLifecycle', () => {
  test('registers the Telegram webhook once per revision and removes it when the provider goes away', async () => {
    const h = harness({ telegram: telegram('r1') })
    await h.lifecycle.reconcile()
    await h.lifecycle.reconcile()
    expect(h.calls).toEqual([
      {
        url: 'https://api.telegram.org/bot111:tok/setWebhook',
        method: 'POST',
        body: {
          url: 'https://tau.example.test/api/webhooks/channels/telegram',
          secret_token: 'secret-1',
          drop_pending_updates: false,
        },
        auth: undefined,
      },
    ])
    h.states.telegram = telegram('r2', '222:new')
    await h.lifecycle.reconcile()
    expect(h.calls.at(-1)?.url).toBe('https://api.telegram.org/bot222:new/setWebhook')
    h.states.telegram = undefined
    await h.lifecycle.reconcile()
    await h.lifecycle.reconcile()
    // Deleted with the token that registered it, exactly once.
    expect(h.calls.slice(2)).toEqual([
      { url: 'https://api.telegram.org/bot222:new/deleteWebhook', method: 'POST', body: undefined, auth: undefined },
    ])
    // Coming back registers again.
    h.states.telegram = telegram('r2', '222:new')
    await h.lifecycle.reconcile()
    expect(h.calls.at(-1)?.url).toBe('https://api.telegram.org/bot222:new/setWebhook')
  })

  test('a provider failure is retried after a minute, not on every reconcile', async () => {
    const h = harness({ telegram: telegram('r1') })
    h.setFailing(true)
    await h.lifecycle.reconcile()
    await h.lifecycle.reconcile()
    expect(h.calls).toHaveLength(1)
    h.advance(60_001)
    h.setFailing(false)
    await h.lifecycle.reconcile()
    await h.lifecycle.reconcile()
    expect(h.calls).toHaveLength(2)
  })

  test('registers Discord commands globally or per guild and reports gateway-relevant changes', async () => {
    const h = harness({ discord: discord('d1') })
    await h.lifecycle.reconcile()
    expect(h.calls).toEqual([
      {
        url: 'https://discord.com/api/v10/applications/app-1/commands',
        method: 'PUT',
        body: FICUS_DISCORD_COMMANDS,
        auth: 'Bot bot-tok',
      },
    ])
    expect(h.discordChanges).toEqual(['d1'])
    h.states.discord = discord('d2', 'g-9')
    await h.lifecycle.reconcile()
    expect(h.calls.at(-2)?.url).toBe('https://discord.com/api/v10/applications/app-1/guilds/g-9/commands')
    expect(h.calls.at(-1)).toMatchObject({
      url: 'https://discord.com/api/v10/applications/app-1/commands',
      body: FICUS_DISCORD_DM_COMMANDS,
    })
    expect(h.discordChanges).toEqual(['d1', 'd2'])
    h.states.discord = undefined
    await h.lifecycle.reconcile()
    await h.lifecycle.reconcile()
    expect(h.discordChanges).toEqual(['d1', 'd2', undefined])
    expect(h.calls).toHaveLength(3)
  })

  test('nothing is registered without a discovered Discord application id', async () => {
    const state = discord('d1')
    delete (state.configuration as { applicationId?: string }).applicationId
    const h = harness({ discord: state })
    await h.lifecycle.reconcile()
    expect(h.calls).toEqual([])
    expect(h.discordChanges).toEqual(['d1'])
  })
})
