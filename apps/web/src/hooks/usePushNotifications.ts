import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '../api/client'
import type { PushSubscription } from '@ficus/shared'
import { desktopBridge } from '../lib/desktop'
import { PUSH_SUBSCRIPTION_ID_STORAGE_KEY } from '@ficus/shared/browser-keys'

interface UsePushNotificationsReturn {
  isSupported: boolean
  isSubscribed: boolean
  permission: NotificationPermission | 'unsupported'
  subscriptions: PushSubscription[]
  currentSubscriptionId: string | null
  subscribe: () => Promise<void>
  unsubscribe: () => Promise<void>
  removeSubscription: (id: string) => Promise<void>
  refresh: () => Promise<void>
  error: string | null
}

export function usePushNotifications(): UsePushNotificationsReturn {
  const [isSupported] = useState(() => !desktopBridge() && 'serviceWorker' in navigator && 'PushManager' in window)
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(
    isSupported ? Notification.permission : 'unsupported'
  )
  const [subscriptions, setSubscriptions] = useState<PushSubscription[]>([])
  const [currentSubscriptionId, setCurrentSubscriptionId] = useState<string | null>(() =>
    localStorage.getItem(PUSH_SUBSCRIPTION_ID_STORAGE_KEY)
  )
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const subs = await apiFetch<PushSubscription[]>('/push/subscriptions')
      setSubscriptions(subs)

      // Clear stale localStorage reference if server no longer has this subscription
      const storedId = localStorage.getItem(PUSH_SUBSCRIPTION_ID_STORAGE_KEY)
      if (storedId && !subs.some((s) => s.id === storedId)) {
        localStorage.removeItem(PUSH_SUBSCRIPTION_ID_STORAGE_KEY)
        setCurrentSubscriptionId(null)
      }
    } catch (err) {
      console.error('Failed to fetch subscriptions:', err)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Service worker registration is handled by lib/serviceWorker.ts in main.tsx
  // We just need to wait for it to be ready when subscribing

  const subscribe = useCallback(async () => {
    setError(null)

    if (!isSupported) {
      setError(
        desktopBridge()
          ? 'Enable desktop notifications from the Tau application menu.'
          : 'Push notifications not supported'
      )
      return
    }

    try {
      const perm = await Notification.requestPermission()
      setPermission(perm)

      if (perm !== 'granted') {
        setError('Notification permission denied')
        return
      }

      const registration = await navigator.serviceWorker.ready

      // Get VAPID public key
      const { publicKey } = await apiFetch<{ publicKey: string }>('/push/vapid-public-key')

      // Check for existing subscription with mismatched key
      const existingSubscription = await registration.pushManager.getSubscription()
      if (existingSubscription) {
        // Unsubscribe the old one first - it may have a different VAPID key
        // This handles cases where keys were regenerated or changed
        await existingSubscription.unsubscribe()
      }

      // Subscribe to push
      const pushSubscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      })

      const json = pushSubscription.toJSON()

      // Send to server
      const saved = await apiFetch<PushSubscription>('/push/subscribe', {
        method: 'POST',
        body: JSON.stringify({
          endpoint: json.endpoint,
          keys: json.keys,
          userAgent: navigator.userAgent,
        }),
      })

      localStorage.setItem(PUSH_SUBSCRIPTION_ID_STORAGE_KEY, saved.id)
      setCurrentSubscriptionId(saved.id)
      await refresh()
    } catch (err: any) {
      setError(err.message || 'Failed to subscribe')
      console.error('Subscribe error:', err)
    }
  }, [isSupported, refresh])

  const unsubscribe = useCallback(async () => {
    setError(null)

    if (!currentSubscriptionId) return

    try {
      await apiFetch(`/push/subscribe/${currentSubscriptionId}`, {
        method: 'DELETE',
      })

      // Also unsubscribe from browser
      const registration = await navigator.serviceWorker.ready
      const pushSubscription = await registration.pushManager.getSubscription()
      if (pushSubscription) {
        await pushSubscription.unsubscribe()
      }

      localStorage.removeItem(PUSH_SUBSCRIPTION_ID_STORAGE_KEY)
      setCurrentSubscriptionId(null)
      await refresh()
    } catch (err: any) {
      setError(err.message || 'Failed to unsubscribe')
      console.error('Unsubscribe error:', err)
    }
  }, [currentSubscriptionId, refresh])

  const removeSubscription = useCallback(
    async (id: string) => {
      try {
        await apiFetch(`/push/subscribe/${id}`, { method: 'DELETE' })

        if (id === currentSubscriptionId) {
          localStorage.removeItem(PUSH_SUBSCRIPTION_ID_STORAGE_KEY)
          setCurrentSubscriptionId(null)
        }

        await refresh()
      } catch (err: any) {
        setError(err.message || 'Failed to remove subscription')
      }
    },
    [currentSubscriptionId, refresh]
  )

  return {
    isSupported,
    isSubscribed: currentSubscriptionId !== null,
    permission,
    subscriptions,
    currentSubscriptionId,
    subscribe,
    unsubscribe,
    removeSubscription,
    refresh,
    error,
  }
}

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = window.atob(base64)
  const buffer = new ArrayBuffer(rawData.length)
  const outputArray = new Uint8Array(buffer)
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i)
  }
  return outputArray
}
