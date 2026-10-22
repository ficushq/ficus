// Thin shim over @ficus/client-core (see ./clientInstance).
import { client } from './clientInstance'
import type { ListMonitorsParams } from '@ficus/client-core'

export type { ListMonitorsParams }

export const monitorsApi = {
  list: (params?: ListMonitorsParams) => client.monitors.list(params),
  get: (id: string) => client.monitors.get(id),
  logs: (id: string, tail = 100) => client.monitors.logs(id, tail),
  cancel: (id: string) => client.monitors.cancel(id),
}
