import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { Hono } from 'hono'
import { webhooksRouter } from '../../routes/webhooks'
import { discordProvider } from './provider'
import { ChannelInstance } from '../../entities/ChannelInstance'
import { InboxMessage } from '../../entities/InboxMessage'
import * as settings from '../../services/integrations/channels/settings'

const app = new Hono().route('/webhooks', webhooksRouter)
const originalFetch = globalThis.fetch
const spies: Array<{ mockRestore(): void }> = []
afterEach(() => {
  globalThis.fetch = originalFetch
  for (const spy of spies.splice(0)) spy.mockRestore()
})

describe('Discord verified HTTP interactions', () => {
  for (const scope of ['channel', 'thread', 'dm'] as const) {
    it(`acknowledges before lookup and responds to ${scope} control commands without agent work`, async () => {
      const requests: Array<{ url: string; method?: string; body?: any }> = []
      globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        requests.push({
          url: String(url),
          method: init?.method,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        })
        return new Response(null, { status: 204 })
      }) as unknown as typeof fetch
      spies.push(spyOn(discordProvider, 'verifySignature').mockResolvedValue(true))
      spies.push(
        spyOn(settings, 'getChannelIntegrationValue').mockImplementation((key) =>
          key === 'DISCORD_GUILD_ID' ? 'configured-guild' : undefined
        )
      )
      const lookup = spyOn(ChannelInstance, 'findByProvider').mockImplementation(async (_provider, platform) => {
        expect(requests[0]?.url).toEndWith('/interactions/id/token/callback')
        expect(requests[0]?.body).toEqual({ type: 5 })
        expect(platform).toBe(scope === 'dm' ? 'configured-guild' : 'guild')
        return new ChannelInstance({ id: 'bot', provider: 'discord', disabled: false } as any)
      })
      const inbox = spyOn(InboxMessage, 'send')
      spies.push(lookup, inbox)
      const res = await app.request('/webhooks/channels/discord', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'id',
          application_id: 'application',
          token: 'token',
          type: 2,
          guild_id: scope === 'dm' ? undefined : 'guild',
          context: scope === 'dm' ? 1 : 0,
          channel_id: 'destination',
          channel:
            scope === 'dm'
              ? undefined
              : { type: scope === 'thread' ? 11 : 0, parent_id: scope === 'thread' ? 'parent' : undefined },
          user: { id: 'user', username: 'User' },
          data: { name: 'ficus', options: [{ name: scope === 'dm' ? 'help' : 'squad', type: 1 }] },
        }),
      })
      expect(res.status).toBe(202)
      expect(await res.text()).toBe('')
      expect(requests[1]?.method).toBe('PATCH')
      expect(requests[1]?.body.content).toContain(scope === 'dm' ? 'Commands:' : 'administrator-defined squad route')
      expect(inbox).not.toHaveBeenCalled()
    })
  }

  it('does not acknowledge or execute an unverified request', async () => {
    spies.push(spyOn(discordProvider, 'verifySignature').mockResolvedValue(false))
    const lookup = spyOn(ChannelInstance, 'findByProvider')
    spies.push(lookup)
    globalThis.fetch = (async () => {
      throw new Error('Must not acknowledge unverified requests')
    }) as unknown as typeof fetch
    const res = await app.request('/webhooks/channels/discord', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 2 }),
    })
    expect(res.status).toBe(401)
    expect(lookup).not.toHaveBeenCalled()
  })
})
