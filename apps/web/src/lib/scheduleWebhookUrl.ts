import { apiUrl } from '../api/client'

/**
 * The URL an external system calls to trigger a schedule: the server's public
 * address (which carries its base path, for example `https://host/ficus`) when
 * one is configured, else this page's API URL, which carries the runtime base
 * path the page was served under.
 */
export function scheduleWebhookUrl(scheduleId: string, publicAppUrl?: string | null): string {
  const path = `/webhooks/trigger/${scheduleId}`
  return publicAppUrl ? `${publicAppUrl.replace(/\/+$/, '')}/api${path}` : apiUrl(path)
}
