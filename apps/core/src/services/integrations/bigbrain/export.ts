import type { SanitizedConversationRecord, RuntimeConnection } from '../types'
import type { BigbrainConfigV1 } from './provider'
import { BigbrainClient, type BigbrainFetch } from './client'

export function encodeBigbrainSession(records: readonly SanitizedConversationRecord[]): Uint8Array {
  const lines = records.map((record) => JSON.stringify({ role: record.role, text: record.text }))
  return new TextEncoder().encode(`${lines.join('\n')}\n`)
}

export async function sendBigbrainSession(input: {
  payload: Uint8Array
  connection: RuntimeConnection<BigbrainConfigV1>
  credential: string
  agentId: string
  squadId: string
  streamId: string
  fromLine: number
  fetch?: BigbrainFetch
}): Promise<void> {
  const client = new BigbrainClient({
    apiBase: input.connection.configuration.apiBase,
    credential: () => input.credential,
    fetch: input.fetch,
  })
  await client.sendSession(input.payload, {
    session: 'ficus',
    cwd: '.',
    stream: input.streamId,
    fromLine: input.fromLine,
  })
}
