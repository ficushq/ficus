import { z } from 'zod'
import type { IntegrationPluginV1, ManagedOAuthDriver } from '../plugin'
import type { ProviderValidation } from '../types'
import { parseOAuthCredential } from '../authorization/credential-bundle'

/**
 * Channel integrations as first-class connections: one Discord app, Slack
 * app or Telegram bot per instance, stored, validated and audited the same
 * way every other integration connection is. The chat transports under
 * apps/core/src/channels read their credentials through these plugins.
 *
 * Shapes are what an OAuth install through a managed app would also produce
 * (identity in the configuration, secrets in the credential), so the manual
 * authorization used today can later sit next to a broker-driven one.
 */

export interface ChannelCredentialField {
  key: string
  label: string
  placeholder: string
  required: boolean
  /** Always true today: everything a user pastes is a secret. Identity is discovered, not typed. */
  secret: true
}

export interface ChannelPluginExtension<Credential, Identity> {
  /** Fields the settings card asks for; keys are credential properties. */
  readonly credentialFields: readonly ChannelCredentialField[]
  /** What the provider says this credential is; stored on the configuration after validation. */
  identity(credential: Credential, signal?: AbortSignal): Promise<Identity>
}

export type ChannelPlugin<C, Credential, Identity> = IntegrationPluginV1<C, Credential> & {
  readonly channel: ChannelPluginExtension<Credential, Identity>
}

// ── Schemas ──────────────────────────────────────────────────────────────

const secret = z.string().trim().min(1).max(4096)

export const telegramConfigurationSchema = z.strictObject({
  version: z.literal(1),
  botId: z.string().min(1).optional(),
  username: z.string().min(1).optional(),
})
export const telegramCredentialSchema = z.strictObject({ botToken: secret, webhookSecret: secret })
export type TelegramConfiguration = z.infer<typeof telegramConfigurationSchema>
export type TelegramCredential = z.infer<typeof telegramCredentialSchema>
export type TelegramIdentity = Pick<TelegramConfiguration, 'botId' | 'username'>

export const slackConfigurationSchema = z.strictObject({
  version: z.literal(1),
  teamId: z.string().min(1).optional(),
  botUserId: z.string().min(1).optional(),
  teamName: z.string().min(1).optional(),
  /** Only ever set by a managed (broker) install; a manual save never types it. */
  appId: z.string().min(1).optional(),
})
/** The broker's grant configuration allows a null team name; Core's schema only ever omits it. */
const parseSlackConfigurationInput = (value: unknown): SlackConfiguration => {
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).teamName === null
  ) {
    const { teamName: _teamName, ...rest } = value as Record<string, unknown>
    return slackConfigurationSchema.parse(rest)
  }
  return slackConfigurationSchema.parse(value)
}
export const slackCredentialSchema = z.strictObject({ botToken: secret, signingSecret: secret })
export type SlackConfiguration = z.infer<typeof slackConfigurationSchema>
export type SlackCredential = z.infer<typeof slackCredentialSchema>
export type SlackIdentity = Pick<SlackConfiguration, 'teamId' | 'botUserId' | 'teamName'>

/** Accepts a manual `{botToken, signingSecret}` credential or an OAuth bundle; both hold the bot token. */
function slackBotTokenFromCredential(raw: string): string {
  const parsed: unknown = JSON.parse(raw)
  const manual = slackCredentialSchema.safeParse(parsed)
  if (manual.success) return manual.data.botToken
  return parseOAuthCredential(raw).accessToken
}

export const discordConfigurationSchema = z.strictObject({
  version: z.literal(1),
  applicationId: z.string().min(1).optional(),
  publicKey: z.string().min(1).optional(),
  /** Optional: register slash commands to one guild (instant) instead of globally (up to an hour). */
  guildId: z.string().min(1).optional(),
})
export const discordCredentialSchema = z.strictObject({ botToken: secret })
export type DiscordConfiguration = z.infer<typeof discordConfigurationSchema>
export type DiscordCredential = z.infer<typeof discordCredentialSchema>
export type DiscordIdentity = Pick<DiscordConfiguration, 'applicationId' | 'publicKey'>

// ── Building blocks ──────────────────────────────────────────────────────

const jsonCodec = <T>(schema: z.ZodType<T>) => ({
  parse: (value: unknown): T => schema.parse(typeof value === 'string' ? JSON.parse(value) : value),
  serialize: (value: T): string => JSON.stringify(schema.parse(value)),
})

class ProviderAuthError extends Error {
  constructor(readonly code: 'invalid_auth' | 'provider_unavailable') {
    super(code)
  }
}

/** Every validate() maps the same way: bad credential, provider down, or ok. */
async function validation(probe: () => Promise<void>): Promise<ProviderValidation> {
  try {
    await probe()
    return { ok: true, grantedScopes: [] }
  } catch (error) {
    return { ok: false, code: error instanceof ProviderAuthError ? error.code : 'provider_unavailable' }
  }
}

const sandbox = {
  packages: [],
  setupSteps: [],
  initHooks: [],
  readiness: [],
  skills: [],
  extensions: [],
  protectedBindings: [],
} as const

const presentation = (key: 'discord' | 'slack' | 'telegram', description: string) =>
  ({
    label: key[0]!.toUpperCase() + key.slice(1),
    description,
    icon: key,
    connectionMode: 'channel',
    assignable: false,
    requiredCapabilities: [],
  }) as const

export interface ChannelPluginOptions {
  fetch?: typeof fetch
  telegramApiBase?: string
  slackApiBase?: string
  discordApiBase?: string
}

export function createChannelPlugins(options: ChannelPluginOptions = {}) {
  const fetchImpl = options.fetch ?? fetch
  const telegramApi = options.telegramApiBase ?? 'https://api.telegram.org'
  const slackApi = options.slackApiBase ?? 'https://slack.com/api'
  const discordApi = options.discordApiBase ?? 'https://discord.com/api/v10'
  const timeout = (signal?: AbortSignal) => signal ?? AbortSignal.timeout(10_000)

  // Telegram ─ token in the path; getMe answers { ok, result: { id, username } }.
  const telegramGetMe = async (credential: TelegramCredential, signal?: AbortSignal) => {
    let response: Response
    try {
      response = await fetchImpl(`${telegramApi}/bot${credential.botToken}/getMe`, { signal: timeout(signal) })
    } catch {
      throw new ProviderAuthError('provider_unavailable')
    }
    if (response.status === 401 || response.status === 404) throw new ProviderAuthError('invalid_auth')
    if (!response.ok) throw new ProviderAuthError('provider_unavailable')
    const body = (await response.json()) as { ok?: boolean; result?: { id?: number; username?: string } }
    if (!body.ok || typeof body.result?.id !== 'number') throw new ProviderAuthError('invalid_auth')
    return body.result
  }

  // Slack ─ auth.test answers { ok, error? , team_id, user_id, team }.
  const slackAuthTest = async (botToken: string, signal?: AbortSignal) => {
    let response: Response
    try {
      response = await fetchImpl(`${slackApi}/auth.test`, {
        method: 'POST',
        headers: { authorization: `Bearer ${botToken}` },
        signal: timeout(signal),
      })
    } catch {
      throw new ProviderAuthError('provider_unavailable')
    }
    if (!response.ok) throw new ProviderAuthError('provider_unavailable')
    const body = (await response.json()) as {
      ok?: boolean
      error?: string
      team_id?: string
      user_id?: string
      team?: string
    }
    if (!body.ok) {
      const authErrors = ['invalid_auth', 'not_authed', 'account_inactive', 'token_revoked', 'token_expired']
      throw new ProviderAuthError(authErrors.includes(body.error ?? '') ? 'invalid_auth' : 'provider_unavailable')
    }
    return body
  }

  // Discord ─ bot token; /users/@me proves the token, /applications/@me names the app.
  const discordGet = async <T>(path: string, credential: DiscordCredential, signal?: AbortSignal): Promise<T> => {
    let response: Response
    try {
      response = await fetchImpl(`${discordApi}${path}`, {
        headers: { authorization: `Bot ${credential.botToken}` },
        signal: timeout(signal),
      })
    } catch {
      throw new ProviderAuthError('provider_unavailable')
    }
    if (response.status === 401 || response.status === 403) throw new ProviderAuthError('invalid_auth')
    if (!response.ok) throw new ProviderAuthError('provider_unavailable')
    return (await response.json()) as T
  }

  const telegram: ChannelPlugin<TelegramConfiguration, TelegramCredential, TelegramIdentity> = {
    manifestVersion: 1,
    key: 'telegram',
    adapterVersion: 1,
    presentation: presentation('telegram', 'Connect a Telegram bot, route chats to squads, and deliver notifications.'),
    connection: {
      parseConfiguration: (value) => telegramConfigurationSchema.parse(value),
      safeConfiguration: (configuration) => configuration,
      credential: jsonCodec(telegramCredentialSchema),
    },
    authorization: { kind: 'manual' },
    runtime: {
      provider: {
        key: 'telegram',
        adapterVersion: 1,
        parseConfig: (value) => telegramConfigurationSchema.parse(value),
        validate: ({ credential, signal }) =>
          validation(async () => {
            await telegramGetMe(telegramCredentialSchema.parse(JSON.parse(credential)), signal)
          }),
        capabilities: {},
      },
    },
    sandbox,
    lifecycle: { refresh: false, revoke: false },
    classifyError: () => ({ code: 'provider_unavailable', retryable: true }),
    channel: {
      credentialFields: [
        { key: 'botToken', label: 'Bot token', placeholder: '123456789:…', required: true, secret: true },
      ],
      identity: async (credential, signal) => {
        const me = await telegramGetMe(credential, signal)
        return { botId: String(me.id), ...(me.username ? { username: me.username } : {}) }
      },
    },
  }

  // Managed OAuth: "Add to Slack" through the platform broker, offered
  // alongside manual entry so hosted tenants can bring their own app instead.
  const slackManaged: ManagedOAuthDriver<SlackConfiguration> = {
    kind: 'oauth2',
    adapter: 'slack',
    authorities: ['platform_broker'],
    identity: (configuration) => ({ teamId: configuration.teamId ?? '' }),
    validate: async ({ configuration, credential, signal }) => {
      try {
        const me = await slackAuthTest(credential.accessToken, signal)
        return me.team_id === configuration.teamId && me.user_id === configuration.botUserId
          ? { ok: true, grantedScopes: [] }
          : { ok: false, code: 'workspace_identity_mismatch' }
      } catch (error) {
        return { ok: false, code: error instanceof ProviderAuthError ? error.code : 'provider_unavailable' }
      }
    },
  }

  const slack: ChannelPlugin<SlackConfiguration, SlackCredential, SlackIdentity> = {
    manifestVersion: 1,
    key: 'slack',
    adapterVersion: 1,
    presentation: presentation(
      'slack',
      'Connect a Slack app, route conversations to squads, and deliver notifications.'
    ),
    connection: {
      parseConfiguration: (value) => parseSlackConfigurationInput(value),
      safeConfiguration: (configuration) => configuration,
      credential: jsonCodec(slackCredentialSchema),
    },
    authorization: { kind: 'manual', managed: slackManaged },
    runtime: {
      provider: {
        key: 'slack',
        adapterVersion: 1,
        parseConfig: (value) => parseSlackConfigurationInput(value),
        validate: ({ credential, signal }) =>
          validation(async () => {
            await slackAuthTest(slackBotTokenFromCredential(credential), signal)
          }),
        capabilities: {},
      },
    },
    sandbox,
    lifecycle: { refresh: false, revoke: false },
    classifyError: () => ({ code: 'provider_unavailable', retryable: true }),
    channel: {
      credentialFields: [
        { key: 'botToken', label: 'Bot token', placeholder: 'xoxb-…', required: true, secret: true },
        {
          key: 'signingSecret',
          label: 'Signing secret',
          placeholder: 'Slack app signing secret',
          required: true,
          secret: true,
        },
      ],
      identity: async (credential, signal) => {
        const me = await slackAuthTest(credential.botToken, signal)
        return {
          ...(me.team_id ? { teamId: me.team_id } : {}),
          ...(me.user_id ? { botUserId: me.user_id } : {}),
          ...(me.team ? { teamName: me.team } : {}),
        }
      },
    },
  }

  const discord: ChannelPlugin<DiscordConfiguration, DiscordCredential, DiscordIdentity> = {
    manifestVersion: 1,
    key: 'discord',
    adapterVersion: 1,
    presentation: presentation('discord', 'Connect a Discord bot, route servers to squads, and deliver notifications.'),
    connection: {
      parseConfiguration: (value) => discordConfigurationSchema.parse(value),
      safeConfiguration: (configuration) => configuration,
      credential: jsonCodec(discordCredentialSchema),
    },
    authorization: { kind: 'manual' },
    runtime: {
      provider: {
        key: 'discord',
        adapterVersion: 1,
        parseConfig: (value) => discordConfigurationSchema.parse(value),
        validate: ({ credential, signal }) =>
          validation(async () => {
            await discordGet('/users/@me', discordCredentialSchema.parse(JSON.parse(credential)), signal)
          }),
        capabilities: {},
      },
    },
    sandbox,
    lifecycle: { refresh: false, revoke: false },
    classifyError: () => ({ code: 'provider_unavailable', retryable: true }),
    channel: {
      credentialFields: [
        { key: 'botToken', label: 'Bot token', placeholder: 'Discord bot token', required: true, secret: true },
      ],
      identity: async (credential, signal) => {
        const app = await discordGet<{ id?: string; verify_key?: string }>('/applications/@me', credential, signal)
        return {
          ...(app.id ? { applicationId: app.id } : {}),
          ...(app.verify_key ? { publicKey: app.verify_key } : {}),
        }
      },
    },
  }

  return { telegram, slack, discord }
}

export const channelPlugins = createChannelPlugins()
export type ChannelProviderKey = keyof typeof channelPlugins
export const channelProviderKeys = Object.keys(channelPlugins) as ChannelProviderKey[]
export const isChannelProviderKey = (value: string): value is ChannelProviderKey => Object.hasOwn(channelPlugins, value)
