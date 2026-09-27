import { describe, expect, test } from 'bun:test'
import { createChannelPlugins } from './plugins'

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>

/** A fake provider API keyed by URL substring. */
function fakeFetch(routes: Record<string, Handler | Response>) {
  const calls: { url: string; init?: RequestInit }[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    const match = Object.entries(routes).find(([needle]) => url.includes(needle))
    if (!match) return new Response('not found', { status: 404 })
    const [, handler] = match
    return typeof handler === 'function' ? handler(url, init) : handler.clone()
  }) as typeof fetch
  return { fetchImpl, calls }
}

const header = (init: RequestInit | undefined, name: string) => new Headers(init?.headers).get(name)

describe('channel plugins', () => {
  test('credentials are JSON codecs that reject missing secrets and never accept a bare token', () => {
    const { telegram, slack, discord } = createChannelPlugins({ fetch: fakeFetch({}).fetchImpl })
    const roundTrip = <T>(
      plugin: { connection: { credential: { parse(value: unknown): T; serialize(value: T): string } } },
      value: unknown
    ) =>
      plugin.connection.credential.parse(
        plugin.connection.credential.serialize(plugin.connection.credential.parse(value))
      )
    expect(roundTrip(telegram, { botToken: '123:abc', webhookSecret: 's3cr3t' })).toEqual({
      botToken: '123:abc',
      webhookSecret: 's3cr3t',
    })
    expect(roundTrip(slack, { botToken: 'xoxb-1', signingSecret: 'sig' })).toEqual({
      botToken: 'xoxb-1',
      signingSecret: 'sig',
    })
    expect(roundTrip(discord, { botToken: 'bot-token' })).toEqual({ botToken: 'bot-token' })
    expect(() => telegram.connection.credential.parse('123:abc')).toThrow()
    expect(() => telegram.connection.credential.parse({ botToken: '123:abc' })).toThrow()
    expect(() => slack.connection.credential.parse({ botToken: 'xoxb-1' })).toThrow()
    expect(() => discord.connection.credential.parse({})).toThrow()
    // Serialized form is what the secret store holds: JSON, parseable back.
    expect(JSON.parse(discord.connection.credential.serialize({ botToken: 'bot-token' }))).toEqual({
      botToken: 'bot-token',
    })
  })

  test('configurations carry only discovered identity and accept an empty start', () => {
    const { telegram, slack, discord } = createChannelPlugins({ fetch: fakeFetch({}).fetchImpl })
    expect(telegram.connection.parseConfiguration({ version: 1 })).toEqual({ version: 1 })
    expect(telegram.connection.parseConfiguration({ version: 1, botId: '123', username: 'tau_bot' })).toEqual({
      version: 1,
      botId: '123',
      username: 'tau_bot',
    })
    expect(
      slack.connection.parseConfiguration({ version: 1, teamId: 'T1', botUserId: 'U1', teamName: 'Acme' })
    ).toEqual({
      version: 1,
      teamId: 'T1',
      botUserId: 'U1',
      teamName: 'Acme',
    })
    expect(
      discord.connection.parseConfiguration({ version: 1, applicationId: 'app', publicKey: 'pk', guildId: 'g' })
    ).toEqual({ version: 1, applicationId: 'app', publicKey: 'pk', guildId: 'g' })
    expect(() => telegram.connection.parseConfiguration({ version: 1, botToken: 'leak' })).toThrow()
  })

  test('Telegram validates with getMe and discovers the bot identity', async () => {
    const { fetchImpl, calls } = fakeFetch({
      '/bot123:abc/getMe': Response.json({ ok: true, result: { id: 123, username: 'tau_bot' } }),
      '/bot123:bad/getMe': new Response(JSON.stringify({ ok: false, description: 'Unauthorized' }), { status: 401 }),
    })
    const { telegram } = createChannelPlugins({ fetch: fetchImpl })
    const credential = telegram.connection.credential.serialize({ botToken: '123:abc', webhookSecret: 's' })
    expect(await telegram.runtime.provider.validate({ credential, configuration: { version: 1 } } as never)).toEqual({
      ok: true,
      grantedScopes: [],
    })
    expect(
      await telegram.runtime.provider.validate({
        credential: telegram.connection.credential.serialize({ botToken: '123:bad', webhookSecret: 's' }),
        configuration: { version: 1 },
      } as never)
    ).toEqual({ ok: false, code: 'invalid_auth' })
    expect(await telegram.channel.identity({ botToken: '123:abc', webhookSecret: 's' })).toEqual({
      botId: '123',
      username: 'tau_bot',
    })
    // The token travels in the path, never logged or echoed by these calls.
    expect(calls.every((call) => !header(call.init, 'authorization'))).toBe(true)
  })

  test('Slack validates with auth.test and discovers the workspace identity', async () => {
    const { fetchImpl, calls } = fakeFetch({
      'auth.test': (_url, init) =>
        header(init, 'authorization') === 'Bearer xoxb-good'
          ? Response.json({ ok: true, team_id: 'T1', user_id: 'U1', team: 'Acme' })
          : Response.json({ ok: false, error: 'invalid_auth' }),
    })
    const { slack } = createChannelPlugins({ fetch: fetchImpl })
    const good = slack.connection.credential.serialize({ botToken: 'xoxb-good', signingSecret: 'sig' })
    const bad = slack.connection.credential.serialize({ botToken: 'xoxb-bad', signingSecret: 'sig' })
    expect(await slack.runtime.provider.validate({ credential: good, configuration: { version: 1 } } as never)).toEqual(
      {
        ok: true,
        grantedScopes: [],
      }
    )
    expect(await slack.runtime.provider.validate({ credential: bad, configuration: { version: 1 } } as never)).toEqual({
      ok: false,
      code: 'invalid_auth',
    })
    expect(await slack.channel.identity({ botToken: 'xoxb-good', signingSecret: 'sig' })).toEqual({
      teamId: 'T1',
      botUserId: 'U1',
      teamName: 'Acme',
    })
    expect(calls.length).toBe(3)
  })

  test('Discord validates the bot user and discovers the application identity', async () => {
    const { fetchImpl } = fakeFetch({
      '/users/@me': (_url, init) =>
        header(init, 'authorization') === 'Bot good'
          ? Response.json({ id: 'bot-user' })
          : new Response('{"message":"401: Unauthorized"}', { status: 401 }),
      '/applications/@me': Response.json({ id: 'app-1', verify_key: 'pk-1', name: 'Ficus' }),
    })
    const { discord } = createChannelPlugins({ fetch: fetchImpl })
    const good = discord.connection.credential.serialize({ botToken: 'good' })
    expect(
      await discord.runtime.provider.validate({ credential: good, configuration: { version: 1 } } as never)
    ).toEqual({ ok: true, grantedScopes: [] })
    expect(
      await discord.runtime.provider.validate({
        credential: discord.connection.credential.serialize({ botToken: 'bad' }),
        configuration: { version: 1 },
      } as never)
    ).toEqual({ ok: false, code: 'invalid_auth' })
    expect(await discord.channel.identity({ botToken: 'good' })).toEqual({ applicationId: 'app-1', publicKey: 'pk-1' })
  })

  test('a provider outage is reported as unavailable, not as a bad credential', async () => {
    const { fetchImpl } = fakeFetch({ getMe: () => Promise.reject(new Error('ECONNRESET')) })
    const { telegram } = createChannelPlugins({ fetch: fetchImpl })
    const credential = telegram.connection.credential.serialize({ botToken: '1:a', webhookSecret: 's' })
    expect(await telegram.runtime.provider.validate({ credential, configuration: { version: 1 } } as never)).toEqual({
      ok: false,
      code: 'provider_unavailable',
    })
  })

  test('plugins advertise the channel connection mode and their editable secret fields', () => {
    const plugins = createChannelPlugins({ fetch: fakeFetch({}).fetchImpl })
    for (const plugin of Object.values(plugins)) {
      expect(plugin.presentation.connectionMode).toBe('channel')
      expect(plugin.presentation.assignable).toBe(false)
      expect(plugin.authorization.kind).toBe('manual')
      expect(plugin.channel.credentialFields.every((field) => field.secret)).toBe(true)
    }
    expect(plugins.telegram.authorization).toEqual({ kind: 'manual' })
    expect(plugins.discord.authorization).toEqual({ kind: 'manual' })
    expect(plugins.telegram.channel.credentialFields.map((f) => f.key)).toEqual(['botToken'])
    expect(plugins.slack.channel.credentialFields.map((f) => f.key)).toEqual(['botToken', 'signingSecret'])
    expect(plugins.discord.channel.credentialFields.map((f) => f.key)).toEqual(['botToken'])
  })

  test('Slack additionally offers a managed OAuth driver scoped to the platform broker, alongside manual entry', () => {
    const { slack } = createChannelPlugins({ fetch: fakeFetch({}).fetchImpl })
    expect(slack.authorization.kind).toBe('manual')
    if (slack.authorization.kind !== 'manual') throw new Error('unreachable')
    const managed = slack.authorization.managed
    expect(managed).toBeDefined()
    expect(managed?.kind).toBe('oauth2')
    expect(managed?.adapter).toBe('slack')
    expect(managed?.authorities).toEqual(['platform_broker'])
    expect(managed?.identity?.({ version: 1, teamId: 'T1' })).toEqual({ teamId: 'T1' })
  })

  test('Slack provider validate accepts a manual credential or an OAuth bundle, both by bot token', async () => {
    const { fetchImpl } = fakeFetch({
      'auth.test': (_url, init) =>
        header(init, 'authorization') === 'Bearer xoxb-manual' ||
        header(init, 'authorization') === 'Bearer xoxb-managed'
          ? Response.json({ ok: true, team_id: 'T1', user_id: 'U1', team: 'Acme' })
          : Response.json({ ok: false, error: 'invalid_auth' }),
    })
    const { slack } = createChannelPlugins({ fetch: fetchImpl })
    const manualCredential = slack.connection.credential.serialize({ botToken: 'xoxb-manual', signingSecret: 'sig' })
    expect(
      await slack.runtime.provider.validate({ credential: manualCredential, configuration: { version: 1 } } as never)
    ).toEqual({ ok: true, grantedScopes: [] })

    const bundleCredential = JSON.stringify({
      version: 1,
      accessToken: 'xoxb-managed',
      refreshToken: null,
      expiresAt: null,
      tokenRevision: 1,
    })
    expect(
      await slack.runtime.provider.validate({ credential: bundleCredential, configuration: { version: 1 } } as never)
    ).toEqual({ ok: true, grantedScopes: [] })
  })

  test('Slack managed validate mismatch reports workspace_identity_mismatch, mirroring the notion pattern', async () => {
    const { fetchImpl } = fakeFetch({
      'auth.test': Response.json({ ok: true, team_id: 'T-actual', user_id: 'U-actual', team: 'Acme' }),
    })
    const { slack } = createChannelPlugins({ fetch: fetchImpl })
    if (slack.authorization.kind !== 'manual') throw new Error('unreachable')
    const managed = slack.authorization.managed!
    const bundle = {
      version: 1 as const,
      accessToken: 'xoxb-managed',
      refreshToken: null,
      expiresAt: null,
      tokenRevision: 1,
    }

    expect(
      await managed.validate({
        configuration: { version: 1, teamId: 'T-actual', botUserId: 'U-actual' },
        credential: bundle,
      })
    ).toEqual({ ok: true, grantedScopes: [] })

    expect(
      await managed.validate({
        configuration: { version: 1, teamId: 'T-different', botUserId: 'U-actual' },
        credential: bundle,
      })
    ).toEqual({ ok: false, code: 'workspace_identity_mismatch' })

    expect(
      await managed.validate({
        configuration: { version: 1, teamId: 'T-actual', botUserId: 'U-different' },
        credential: bundle,
      })
    ).toEqual({ ok: false, code: 'workspace_identity_mismatch' })
  })

  test('Slack configuration accepts the broker-issued appId and a null team name', () => {
    const { slack } = createChannelPlugins({ fetch: fakeFetch({}).fetchImpl })
    expect(
      slack.connection.parseConfiguration({
        version: 1,
        teamId: 'T1',
        teamName: null,
        botUserId: 'U1',
        appId: 'A1',
      })
    ).toEqual({ version: 1, teamId: 'T1', botUserId: 'U1', appId: 'A1' })
    expect(
      slack.connection.parseConfiguration({ version: 1, teamId: 'T1', teamName: 'Acme', botUserId: 'U1', appId: 'A1' })
    ).toEqual({ version: 1, teamId: 'T1', teamName: 'Acme', botUserId: 'U1', appId: 'A1' })
  })
})
