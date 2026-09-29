import { describe, expect, it } from 'bun:test'
import { ATTENTION_TOPICS, attentionSocketUrl, isHintFrame } from './ws'

describe('attentionSocketUrl', () => {
  it('swaps the scheme and appends the token', () => {
    expect(attentionSocketUrl('https://ficus.example.com', 'abc/def')).toBe(
      'wss://ficus.example.com/ws?token=abc%2Fdef'
    )
    expect(attentionSocketUrl('http://localhost:3000/', 'x')).toBe('ws://localhost:3000/ws?token=x')
  })
})

describe('isHintFrame', () => {
  it('accepts event frames on attention topics only', () => {
    for (const topic of ATTENTION_TOPICS) {
      expect(isHintFrame({ type: 'event', topic, event: 'anything', data: {} })).toBe(true)
    }
    expect(isHintFrame({ type: 'event', topic: 'workstreams:abc', event: 'workStream.updated', data: {} })).toBe(true)
    expect(isHintFrame({ type: 'event', topic: 'machines', event: 'machine.status', data: {} })).toBe(false)
    expect(isHintFrame({ type: 'subscribed', topic: 'actions' })).toBe(false)
    expect(isHintFrame({ type: 'error', message: 'nope' })).toBe(false)
    expect(isHintFrame(null)).toBe(false)
    expect(isHintFrame('event')).toBe(false)
  })
})
