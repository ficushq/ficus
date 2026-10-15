import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { AgentSession } from '../entities/AgentSession'
import { flushInferenceUsage, setInferenceUsageSinkForTest } from '../services/inference-usage'
import type { InferenceUsageEvent } from '../services/inference-usage/types'
import { recordSpeechSynthesis, reformatForSpeech, ttsAttribution } from './tts'

const userId = '11111111-1111-4111-8111-111111111111'
const agentId = '22222222-2222-4222-8222-222222222222'
const squadId = '33333333-3333-4333-8333-333333333333'

const spies: Array<{ mockRestore: () => void }> = []
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore()
  setInferenceUsageSinkForTest(undefined)
})

describe('text to speech cost accounting', () => {
  test('a read-aloud is attributed to the caller and to the agent and squad whose message it is', () => {
    expect(ttsAttribution({ type: 'user', userId }, agentId, squadId)).toEqual({ userId, agentId, squadId })
    expect(ttsAttribution({ type: 'legacy' }, agentId, null)).toEqual({ agentId, squadId: null })
  })

  test('synthesis is recorded as tts, billed by the characters sent', async () => {
    const seen: InferenceUsageEvent[] = []
    setInferenceUsageSinkForTest((event) => void seen.push(event))
    const text = 'Your build passed.'
    recordSpeechSynthesis(text, { userId, agentId, squadId })
    await flushInferenceUsage()
    expect(seen).toEqual([
      expect.objectContaining({
        feature: 'tts',
        provider: 'google',
        accountId: 'google-cloud',
        billing: 'api',
        units: { characters: text.length },
        attribution: { userId, agentId, squadId },
      }),
    ])
  })

  test('the speech rewrite session records its calls as tts-reformat', async () => {
    const createSpy = spyOn(AgentSession, 'create').mockResolvedValue({
      pi: {
        subscribe: (listener: (event: unknown) => void) => {
          queueMicrotask(() => {
            listener({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Short.' } })
            listener({ type: 'agent_end', messages: [] })
          })
          return () => {}
        },
        prompt: async () => {},
      },
    } as never)
    spies.push(createSpy)
    expect(await reformatForSpeech('A long message.', { userId, agentId, squadId })).toBe('Short.')
    const options = (
      createSpy.mock.calls[0] as unknown as [{ usage: { feature: string; attribution: () => unknown } }]
    )[0]
    expect(options.usage.feature).toBe('tts-reformat')
    expect(options.usage.attribution()).toEqual({ userId, agentId, squadId })
  })
})
