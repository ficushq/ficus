import { describe, expect, test } from 'bun:test'
import type { RequestOptions, Transport } from '../transport'
import { agentQuestionsResource } from './agentQuestions'

function mockTransport() {
  const calls: Array<{ path: string; options?: RequestOptions }> = []
  const transport: Transport = {
    request: async <T>(path: string, options?: RequestOptions) => {
      calls.push({ path, options })
      return { id: 'question-1' } as T
    },
    openStream: async () => {
      throw new Error('not used')
    },
    wsUrl: (path) => `ws://test${path}`,
    url: (path) => `http://test${path}`,
  }
  return { transport, calls }
}

describe('agentQuestionsResource', () => {
  test('dismisses a question with or without a reason', async () => {
    const { transport, calls } = mockTransport()

    await agentQuestionsResource(transport).dismissAgentQuestion('question-1', 'stale')
    await agentQuestionsResource(transport).dismissAgentQuestion('question-2')

    expect(calls[0]).toEqual({
      path: '/agent-questions/question-1',
      options: { method: 'DELETE', body: { reason: 'stale' } },
    })
    expect(calls[1]).toEqual({ path: '/agent-questions/question-2', options: { method: 'DELETE' } })
  })

  test('acknowledges a specific failed generation without affecting the answer', async () => {
    const { transport, calls } = mockTransport()
    await agentQuestionsResource(transport).dismissAgentQuestionDeliveryFailure('question-1', 2)
    expect(calls[0]).toEqual({
      path: '/agent-questions/question-1/dismiss-delivery-failure',
      options: { method: 'POST', body: { generation: 2 } },
    })
  })

  test('retries failed answer delivery through the exact question route', async () => {
    const { transport, calls } = mockTransport()

    await agentQuestionsResource(transport).retryAgentQuestionAnswerDelivery('question-1')

    expect(calls[0]).toEqual({
      path: '/agent-questions/question-1/retry-delivery',
      options: { method: 'POST' },
    })
  })
})
