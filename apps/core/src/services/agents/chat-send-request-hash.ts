import { createHash } from 'crypto'

/** The two persisted Agent.sendMessage hash versions. Keep callers on this canonical encoding. */
export function chatSendRequestHashes(input: {
  agentId: string
  clientId: string
  content: string
  imageIds?: string[]
  deliveryMode: 'steer' | 'follow-up'
}): { current: string; legacy: string } {
  const { agentId, clientId, content, imageIds = [], deliveryMode } = input
  const hash = (payload: object) => createHash('sha256').update(JSON.stringify(payload)).digest('hex')
  return {
    current: hash({ v: 3, agentId, clientId, content, imageIds, deliveryMode }),
    legacy: hash({ v: 2, agentId, content, imageIds, deliveryMode }),
  }
}
