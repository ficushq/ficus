import { pushCategoryFor } from './push-category'
import { enqueueDesktopNotifications } from '../push/desktop'
import type { PushCategory } from '@ficus/shared'
import { pushAlertText, pushEventType } from '@ficus/shared/push-relay'
import { WorkStream } from '../../entities/WorkStream'
import { requireAllowedChannel } from '../channel-policy'
import { getVapidContactSubject } from '../push/vapid'
import { getSettingsStore } from '../settings'
import { pushRelayConfig, sendRelayAlert } from '../push/relay'
import webpush from 'web-push'
import { parseAssistantInboxConversationId, parseWorkspaceVoiceUserId } from '@ficus/shared'
import { assistantInboxOwner } from '../assistant-inbox'
import type { NotificationConfig, NotificationRule, EventContext, SquadNotificationConfig } from './types'
import {
  getPushSubscriptionsByUserWithKeys,
  deletePushSubscriptionIfUnchanged,
  type PushSubscriptionWithKeys,
} from '../push'
import { sendApnsNotification, type ApnsEnvironment } from '../push/apns'
import { getApnsDevicesByUser, deleteApnsDeviceByToken } from '../push/apns-devices'
import { getVapidKeys } from '../push'
import { getUserIdsWithPermission } from '../rbac'
import { UserNotificationPreferences } from '../../entities/UserNotificationPreferences'
import type { eventEmitter } from '../../lib/infra/event-emitter'
import { createLogger } from '../../lib/infra/logger'
import {
  getNotificationProvider,
  type NotificationEvent as ChannelNotificationEvent,
  type ChannelProvider,
} from '../../channels'
import { ChannelInstance } from '../../entities/ChannelInstance'
import { Squad } from '../../entities/Squad'
import { buildNotificationEvent, getAppOrigin } from './event-builders'
import { listAgentQuestionNotifyUserIds } from '../agents/questions'

const log = createLogger('notify')

export class NotificationService {
  private config: NotificationConfig | null = null
  private vapidConfigured = false
  private vapidSubject: string | undefined

  setConfig(config: NotificationConfig): void {
    this.config = config
  }

  register(emitter: typeof eventEmitter): () => void {
    return emitter.onAny((event, data) => this.notify(event, data))
  }

  getConfig(): NotificationConfig | null {
    return this.config
  }

  async configureVapid(): Promise<void> {
    const subject = getVapidContactSubject()
    if (!subject) {
      this.vapidConfigured = false
      return
    }
    if (this.vapidConfigured && this.vapidSubject === subject) return

    try {
      const keys = await getVapidKeys()
      webpush.setVapidDetails(subject, keys.publicKey, keys.privateKey)
      this.vapidConfigured = true
      this.vapidSubject = subject
    } catch (err) {
      log.error('Failed to configure VAPID:', err)
    }
  }

  matchRule(context: EventContext, data?: unknown): NotificationRule | null {
    if (!this.config) return null

    for (const rule of this.config.rules) {
      if (rule.event && rule.event !== context.event) continue
      if (rule.match && !this.matchesData(rule.match, data)) continue

      return rule
    }

    return null
  }

  private matchesData(match: Record<string, unknown>, data: unknown): boolean {
    if (!data || typeof data !== 'object') return false

    for (const [path, expected] of Object.entries(match)) {
      const actual = this.getNestedValue(data, path)
      // An array expectation matches if the actual value is any of the listed values.
      if (Array.isArray(expected)) {
        if (!expected.includes(actual)) return false
      } else if (actual !== expected) {
        return false
      }
    }

    return true
  }

  private getNestedValue(obj: unknown, path: string): unknown {
    const parts = path.split('.')
    let current: unknown = obj

    for (const part of parts) {
      if (current === null || current === undefined || typeof current !== 'object') {
        return undefined
      }
      current = (current as Record<string, unknown>)[part]
    }

    return current
  }

  buildContext(event: string, _data: unknown): EventContext {
    return { event }
  }

  async notify(event: string, data: unknown): Promise<void> {
    if (!this.config) {
      log.debug(`Notification config not loaded; skipping ${event}`)
      return
    }

    const context = this.buildContext(event, data)
    const rule = this.matchRule(context, data)
    if (!rule) {
      log.debug(`Event ${event} matched no notification rule`)
      return
    }

    const enabledChannels = rule.channels.filter((channel) => {
      const channelConfig = this.config?.channels[channel]
      return !channelConfig || channelConfig.enabled
    })
    if (enabledChannels.length === 0) return

    // Build notification event once, shared by all enabled channels. The raw
    // routing input must not cross into a channel implementation either.
    const safeData = data
    const builtNotificationEvent = await buildNotificationEvent(event, safeData)
    const notificationEvent = builtNotificationEvent ? builtNotificationEvent : null

    for (const channel of enabledChannels) {
      log.info(`${event} → ${channel}`)

      try {
        if (channel === 'console') {
          log.info(`${event}: ${notificationEvent?.body || 'Event occurred'}`)
        } else if (channel === 'push') {
          await this.sendPushNotifications(notificationEvent, safeData, event)
        } else {
          // External channel (discord, slack, telegram)
          const externalProvider = getNotificationProvider(channel)
          if (externalProvider && notificationEvent?.squadId) {
            await this.sendToExternalChannel(channel, externalProvider, notificationEvent, notificationEvent.squadId)
          }
        }
      } catch (err) {
        // Log but don't fail - other channels should still be notified
        const safeError = err
        log.error(`Failed to send ${event} to ${channel}:`, safeError)
      }
    }
  }

  private async sendToExternalChannel(
    channel: string,
    provider: ChannelProvider,
    event: ChannelNotificationEvent,
    squadId: string
  ): Promise<void> {
    const squad = await Squad.find(squadId)
    if (!squad) {
      log.debug(`${channel}: squad ${squadId} not found`)
      return
    }

    const config = squad.metadata?.notifications as SquadNotificationConfig | undefined
    const channelConfig = config?.[channel as keyof SquadNotificationConfig]
    if (!channelConfig) {
      log.debug(`${channel}: not configured for squad ${squad.name}`)
      return
    }

    const instance = await ChannelInstance.find(channelConfig.instanceId)
    if (!instance) {
      log.warn(`${channel}: instance ${channelConfig.instanceId} not found`)
      return
    }

    await requireAllowedChannel(instance, channelConfig.channelId)
    await provider.sendNotification!({ instance, channelId: channelConfig.channelId, event })
    log.info(`${channel}: sent to ${channelConfig.channelId}`)
  }

  // Resolve which users' devices should receive a push for this event, then their subscriptions.
  // Inbox events use their concrete recipient; agent questions use their notify-level attention
  // audience (direct recipients and a personal owner always included).
  /** Recipient user IDs that should receive a push for this event (after per-user preferences). */
  private async resolveEnabledPushUserIds(
    data: unknown,
    eventType: string,
    category?: PushCategory
  ): Promise<string[]> {
    let userIds: string[] = []

    if (eventType === 'agent-question.created') {
      const questionId = (data as { questionId?: unknown } | null)?.questionId
      userIds = typeof questionId === 'string' ? await listAgentQuestionNotifyUserIds(questionId) : []
    } else {
      const d = data as { recipientType?: string; recipientId?: string } | undefined
      if (!d?.recipientType || !d.recipientId) return []

      if (d.recipientType === 'user') {
        userIds = [d.recipientId]
      } else if (d.recipientType === 'voice_assistant') {
        // A saved Assistant mailbox belongs to its conversation owner; a deleted conversation has
        // no recipient. Workspace voice falls back to its per-user address.
        const userId = parseAssistantInboxConversationId(d.recipientId)
          ? await assistantInboxOwner(d.recipientId)
          : parseWorkspaceVoiceUserId(d.recipientId)
        userIds = userId ? [userId] : []
      } else if (d.recipientType === 'system') {
        userIds = await getUserIdsWithPermission('inbox:system')
      }
    }

    userIds = [...new Set(userIds)]
    if (userIds.length === 0) return []

    // Respect each user's notification preferences (master push toggle + muted events).
    const allowed = await Promise.all(
      userIds.map(async (id) => ((await UserNotificationPreferences.shouldPush(id, eventType, category)) ? id : null))
    )
    return allowed.filter((id): id is string => id !== null)
  }

  private async sendPushNotifications(
    event: ChannelNotificationEvent | null,
    data: unknown,
    eventType: string
  ): Promise<void> {
    if (!event) {
      log.warn('No notification event built, skipping push')
      return
    }

    await this.configureVapid()

    const category = pushCategoryFor(eventType, event, data)
    const userIds = await this.resolveEnabledPushUserIds(data, eventType, category)
    log.info(`Resolved push recipients for ${eventType}: ${userIds.length > 0 ? userIds.join(', ') : 'none'}`)
    if (userIds.length === 0) {
      log.info(`No push recipients for ${eventType}; skipping push`)
      return
    }

    // Shared push audience: web subscriptions, APNs devices, and the desktop feed.
    await Promise.all([
      this.sendWebPush(userIds, event),
      this.sendApnsPush(userIds, event),
      enqueueDesktopNotifications(userIds, event, eventType, category),
    ])
  }

  private async sendWebPush(userIds: string[], event: ChannelNotificationEvent): Promise<void> {
    if (getSettingsStore().getStoredValue('__integration-enabled:web-push') === 'false' || !getVapidContactSubject())
      return
    const perUser = await Promise.all(userIds.map((id) => getPushSubscriptionsByUserWithKeys(id)))
    const deduped = new Map<string, PushSubscriptionWithKeys>()
    for (const sub of perUser.flat()) deduped.set(sub.id, sub)
    const subscriptions = [...deduped.values()]
    if (subscriptions.length === 0) {
      log.info(`No web push subscriptions for ${userIds.length} recipient(s); skipping web push`)
      return
    }
    log.info(`Sending web push to ${subscriptions.length} subscription(s)`)

    const work = event.workStreamId ? await WorkStream.find(event.workStreamId) : null
    const routing = {
      url: event.url,
      squadId: event.squadId,
      agentId: event.agentId,
      workStreamId: String(event.workStreamNumber ?? work?.number ?? event.workStreamId ?? '') || undefined,
      waitId: event.waitId,
      questionId: event.questionId,
      messageId: event.messageId,
      actionId: event.actionId,
    }

    await Promise.all(
      subscriptions.map(async (sub) => {
        try {
          const prefs = await UserNotificationPreferences.get(sub.userId)
          const text = pushAlertText({
            eventType: pushEventType(event.notificationKind ?? event.type),
            workStreamNumber: event.workStreamNumber ?? work?.number,
            ...(prefs.showPreviews ? { preview: { title: event.title, body: event.body } } : {}),
          })
          // The service worker maps `tag` to Notification.tag, so a later push for the same
          // work replaces the earlier one instead of stacking.
          const payload = JSON.stringify({
            ...routing,
            ...text,
            ...(event.collapseKey ? { tag: event.collapseKey, renotify: true } : {}),
          })
          const result = await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            payload
          )
          log.info(`Push sent to ${sub.id} (${result.statusCode})`)
        } catch (err: any) {
          if (err.statusCode === 410 || err.statusCode === 404) {
            const removed = await deletePushSubscriptionIfUnchanged(sub)
            if (removed) {
              log.info(`Removed invalid push subscription ${sub.id} (${err.statusCode})`)
            } else {
              log.info(`Skipped stale invalid push subscription cleanup ${sub.id} (${err.statusCode})`)
            }
          } else {
            log.error(`Failed to send push to ${sub.id}:`, err.statusCode, err.message, err.body)
          }
        }
      })
    )
  }

  private async sendApnsPush(userIds: string[], event: ChannelNotificationEvent): Promise<void> {
    if (getSettingsStore().getStoredValue('__integration-enabled:apple-push') === 'false') return
    const perUser = await Promise.all(userIds.map((id) => getApnsDevicesByUser(id)))
    const devices = perUser.flat()
    if (devices.length === 0) {
      log.info(`No APNs devices for ${userIds.length} recipient(s); skipping APNs`)
      return
    }
    log.info(`Sending APNs to ${devices.length} device(s)`)
    // This instance's web origin lets a mobile app paired with several instances switch to
    // the right one before deep-linking. Omitted when APP_URL isn't configured.
    const origin = getAppOrigin()

    const work = event.workStreamId ? await WorkStream.find(event.workStreamId) : null
    const workStreamNumber = event.workStreamNumber ?? work?.number
    await Promise.all(
      devices.map(async (device) => {
        const prefs = await UserNotificationPreferences.get(device.userId)
        const presentation = {
          eventType: pushEventType(event.notificationKind ?? event.type),
          workStreamNumber,
          ...(prefs.showPreviews
            ? {
                preview: {
                  title: event.title.slice(0, 200),
                  body: event.body.slice(0, 500),
                  ...(event.subtitle ? { subtitle: event.subtitle.slice(0, 80) } : {}),
                },
              }
            : {}),
        }
        const alert = pushAlertText(presentation)
        if (pushRelayConfig()) {
          if (device.platform !== 'ios' || !device.relayBindingToken) return
          const result = await sendRelayAlert(device.relayBindingToken, {
            ...presentation,
            collapseKey: event.collapseKey,
            threadKey: event.threadKey,
            interruptionLevel: event.interruptionLevel,
            squadId: event.squadId,
            agentId: event.agentId,
            workStreamId: event.workStreamId,
            waitId: event.waitId,
            questionId: event.questionId,
            messageId: event.messageId,
            actionId: event.actionId,
          })
          if (!result.accepted) log.warn(`Push relay declined notification: ${result.reason}`)
          return
        }
        const environment: ApnsEnvironment = device.environment === 'sandbox' ? 'sandbox' : 'production'
        const result = await sendApnsNotification(
          device.apnsToken,
          {
            title: alert.title,
            body: alert.body,
            // Grouping, replacement, and urgency are structure, not content: they apply even when
            // previews are off. The subtitle is content (the squad name), so it follows the preview rule.
            ...(prefs.showPreviews && event.subtitle ? { subtitle: event.subtitle } : {}),
            ...(event.threadKey ? { threadId: event.threadKey } : {}),
            ...(event.collapseKey ? { collapseId: event.collapseKey } : {}),
            ...(event.interruptionLevel ? { interruptionLevel: event.interruptionLevel } : {}),
            data: {
              type: 'open',
              url: event.url,
              squadId: event.squadId,
              agentId: event.agentId,
              workStreamId: workStreamNumber ? String(workStreamNumber) : event.workStreamId,
              waitId: event.waitId,
              questionId: event.questionId,
              messageId: event.messageId,
              actionId: event.actionId,
              ...(origin ? { origin } : {}),
            },
          },
          environment
        )
        // Prune device tokens Apple reports as gone/unregistered. Do not prune BadDeviceToken:
        // it commonly indicates an APNs gateway/environment mismatch rather than a dead token.
        if (!result.ok && (result.status === 410 || result.reason === 'Unregistered')) {
          await deleteApnsDeviceByToken(device.apnsToken)
          log.info(`Removed unregistered APNs device (${result.status} ${result.reason ?? ''})`)
        } else if (!result.ok && result.reason === 'BadDeviceToken') {
          log.warn(`APNs BadDeviceToken for ${environment} device; leaving token registered for retry`)
        }
      })
    )
  }
}

export const notificationService = new NotificationService()
