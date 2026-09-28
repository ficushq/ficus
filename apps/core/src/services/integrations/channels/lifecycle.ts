import { FICUS_DISCORD_COMMANDS, FICUS_DISCORD_DM_COMMANDS, discordCommandsPath } from '@ficus/shared/discord-commands'
import { createLogger } from '../../../lib/infra/logger'
import type { ChannelConnections, ChannelConnectionState } from './connections'

const log = createLogger('channel-lifecycle')
/** After a provider call fails, wait this long before trying the same revision again. */
const RETRY_MS = 60_000

export interface ChannelLifecycleDependencies {
  connections: Pick<ChannelConnections, 'get' | 'webhookUrl'>
  fetch?: typeof fetch
  now?: () => number
  telegramApiBase?: string
  discordApiBase?: string
  /** Called when the usable Discord connection's revision changes (including to none). */
  onDiscordChange?: (state: ChannelConnectionState<'discord'> | undefined) => void | Promise<void>
}

/**
 * Provider-side setup that used to be a manual step, done from the saved
 * connection: Telegram's webhook (registered with the generated secret,
 * removed when the provider is switched off) and Discord's slash commands
 * (registered globally, or to the chosen guild). Idempotent per connection
 * revision, so a reconcile after every snapshot refresh is cheap.
 */
export class ChannelLifecycle {
  readonly #deps: ChannelLifecycleDependencies
  readonly #fetch: typeof fetch
  readonly #now: () => number
  readonly #applied = new Map<string, string>()
  readonly #failedAt = new Map<string, number>()
  #telegramRegistered: { revision: string; botToken: string } | undefined
  #discordRevision: string | undefined

  constructor(deps: ChannelLifecycleDependencies) {
    this.#deps = deps
    this.#fetch = deps.fetch ?? fetch
    this.#now = deps.now ?? Date.now
  }

  async reconcile(): Promise<void> {
    await this.#telegram()
    await this.#discord()
  }

  #shouldTry(key: string, revision: string): boolean {
    if (this.#applied.get(key) === revision) return false
    return (this.#failedAt.get(key) ?? 0) <= this.#now() - RETRY_MS
  }

  #done(key: string, revision: string) {
    this.#applied.set(key, revision)
    this.#failedAt.delete(key)
  }

  #failed(key: string, message: string) {
    this.#failedAt.set(key, this.#now())
    log.warn(message)
  }

  async #telegram(): Promise<void> {
    const state = this.#deps.connections.get('telegram')
    const api = this.#deps.telegramApiBase ?? 'https://api.telegram.org'
    if (!state) {
      // Switched off or removed: take the webhook down with the token that set it.
      const registered = this.#telegramRegistered
      if (!registered || !this.#shouldTry('telegram:delete', registered.revision)) return
      try {
        const response = await this.#fetch(`${api}/bot${registered.botToken}/deleteWebhook`, {
          method: 'POST',
          signal: AbortSignal.timeout(10_000),
        })
        if (!response.ok && response.status !== 401) throw new Error(`HTTP ${response.status}`)
        this.#done('telegram:delete', registered.revision)
        this.#telegramRegistered = undefined
        this.#applied.delete('telegram:set')
        log.info('Telegram webhook removed')
      } catch (error) {
        this.#failed('telegram:delete', `Telegram webhook removal failed: ${String(error)}`)
      }
      return
    }
    const url = this.#deps.connections.webhookUrl('telegram')
    const revision = `${state.revision}:${url}`
    if (!this.#shouldTry('telegram:set', revision)) return
    try {
      const response = await this.#fetch(`${api}/bot${state.credential.botToken}/setWebhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url, secret_token: state.credential.webhookSecret, drop_pending_updates: false }),
        signal: AbortSignal.timeout(10_000),
      })
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; description?: string }
      if (!response.ok || !body.ok) throw new Error(body.description ?? `HTTP ${response.status}`)
      this.#done('telegram:set', revision)
      this.#telegramRegistered = { revision: state.revision, botToken: state.credential.botToken }
      log.info(`Telegram webhook registered at ${url}`)
    } catch (error) {
      this.#failed('telegram:set', `Telegram webhook registration failed: ${String(error)}`)
    }
  }

  async #discord(): Promise<void> {
    const state = this.#deps.connections.get('discord')
    const revision = state?.revision
    if (revision !== this.#discordRevision) {
      this.#discordRevision = revision
      try {
        await this.#deps.onDiscordChange?.(state)
      } catch (error) {
        log.warn(`Discord gateway change handler failed: ${String(error)}`)
      }
    }
    if (!state || !state.configuration.applicationId) return
    const api = this.#deps.discordApiBase ?? 'https://discord.com/api/v10'
    const path = discordCommandsPath(state.configuration.applicationId, state.configuration.guildId)
    const key = `discord:commands`
    const commandsRevision = `${state.revision}:${path}`
    if (!this.#shouldTry(key, commandsRevision)) return
    try {
      const response = await this.#fetch(`${api}${path}`, {
        method: 'PUT',
        headers: { authorization: `Bot ${state.credential.botToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(FICUS_DISCORD_COMMANDS),
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      if (state.configuration.guildId) {
        const dm = await this.#fetch(`${api}${discordCommandsPath(state.configuration.applicationId)}`, {
          method: 'PUT',
          headers: { authorization: `Bot ${state.credential.botToken}`, 'content-type': 'application/json' },
          body: JSON.stringify(FICUS_DISCORD_DM_COMMANDS),
          signal: AbortSignal.timeout(15_000),
        })
        if (!dm.ok) throw new Error(`DM commands HTTP ${dm.status}`)
      }
      this.#done(key, commandsRevision)
      log.info(
        `Discord slash commands registered (${state.configuration.guildId ? `guild ${state.configuration.guildId}` : 'global'})`
      )
    } catch (error) {
      this.#failed(key, `Discord slash command registration failed: ${String(error)}`)
    }
  }
}
