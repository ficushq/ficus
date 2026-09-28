import { expect, test } from 'bun:test'
import type { RenderItem } from '@ficus/client-core'
import { AssistantVoiceReceipts, createAssistantVoiceChannel } from './assistantVoiceChannel'

function confirmed(clientId: string, group: string, executionId = 'execution', pending = false): RenderItem {
  return {
    kind: 'persisted',
    id: clientId,
    blocks: [],
    message: {
      id: clientId,
      agentId: 'agent',
      role: 'human',
      content: 'question',
      createdAt: new Date().toISOString(),
      pending,
      metadata: {
        clientId,
        streamGroupId: group,
        executionId,
        ...(!pending ? { consumedAt: new Date().toISOString() } : {}),
      },
    },
  }
}
test('acceptance, unconfirmed input and a different response group never produce speech', () => {
  const receipts = new AssistantVoiceReceipts()
  receipts.register('voice')
  expect(receipts.ready([])).toEqual([])
  receipts.complete('reply', 'Answer', { streamGroupId: 'g', executionId: 'execution' })
  expect(receipts.ready([confirmed('voice', 'g', 'execution', true)])).toEqual([])
  expect(receipts.ready([confirmed('voice', 'other')])).toEqual([])
  expect(receipts.ready([confirmed('voice', 'g', 'other')])).toEqual([])
  expect(receipts.ready([confirmed('voice', 'g')])).toEqual([{ id: 'reply', text: 'Answer' }])
})
test('a fast completed response waits for persisted identity and reconnect duplicates speak once', () => {
  const receipts = new AssistantVoiceReceipts()
  receipts.register('voice')
  receipts.complete('reply', 'Answer', { streamGroupId: 'g', executionId: 'execution' })
  expect(receipts.ready([])).toEqual([])
  expect(receipts.ready([confirmed('voice', 'g')])).toHaveLength(1)
  receipts.complete('reply', 'Answer', { streamGroupId: 'g', executionId: 'execution' })
  expect(receipts.ready([confirmed('voice', 'g')])).toEqual([])
})
test('typed input and unrelated task updates do not consume a waiting voice receipt', () => {
  const receipts = new AssistantVoiceReceipts()
  receipts.register('voice')
  receipts.complete('other', 'Task update', { streamGroupId: 'other', executionId: 'execution' })
  expect(receipts.ready([confirmed('typed', 'other')])).toEqual([])
  receipts.complete('reply', 'Answer', { streamGroupId: 'g', executionId: 'execution' })
  expect(receipts.ready([confirmed('voice', 'g')])).toEqual([{ id: 'reply', text: 'Answer' }])
})
test('disconnect clears pending speech without claiming execution completion', () => {
  const receipts = new AssistantVoiceReceipts()
  receipts.register('voice')
  receipts.complete('reply', 'Answer', { streamGroupId: 'g', executionId: 'execution' })
  receipts.clear()
  expect(receipts.ready([confirmed('voice', 'g')])).toEqual([])
})
test('speech transport delegates each completed transcription and cannot independently answer or use tools', async () => {
  const submitted: string[][] = []
  const env = { submit: (text: string, id: string) => submitted.push([text, id]) }
  const channel = createAssistantVoiceChannel(() => env)
  const session = await channel.prepareSession({ env, signal: new AbortController().signal })
  expect(session.sessionConfig.tools).toEqual([])
  expect(session.sessionConfig.audio.input.turn_detection).toMatchObject({ create_response: false })
  channel.onServerEvent?.(
    { type: 'conversation.item.input_audio_transcription.completed', item_id: 'audio-1', transcript: ' Hello ' },
    {} as never,
    env
  )
  expect(submitted).toEqual([['Hello', 'audio-1']])
})

test('grouped human rows correlate voice and summaries are spoken only once', () => {
  const receipts = new AssistantVoiceReceipts()
  const typed = confirmed('typed', 'g') as Extract<RenderItem, { kind: 'persisted' }>
  const voice = confirmed('voice', 'g') as Extract<RenderItem, { kind: 'persisted' }>
  typed.mergedFrom = [typed.message, voice.message]
  receipts.register('voice')
  receipts.complete('summary', 'Done', { executionId: 'execution', streamGroupId: 'g', assistantUpdateIds: ['update'] })
  expect(receipts.ready([typed])).toEqual([{ id: 'summary', text: 'Done' }])
  receipts.complete('summary', 'Done', { assistantUpdateIds: ['update'] })
  expect(receipts.ready([typed])).toEqual([])
  receipts.complete('next', 'Another update', { assistantUpdateIds: ['other'] })
  expect(receipts.ready([])).toEqual([{ id: 'next', text: 'Another update' }])
})
