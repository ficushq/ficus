import { describe, expect, it } from 'bun:test'
import { raise, stackingOrder } from './stacking'

describe('stacking', () => {
  it('puts whatever was used last in front, keeping the rest in the order they were used', () => {
    raise('card')
    raise('farmChat')
    raise('chat:a')
    raise('card')
    const mine = stackingOrder().filter((key) => ['card', 'farmChat', 'chat:a'].includes(key))
    expect(mine).toEqual(['farmChat', 'chat:a', 'card'])
    raise('card')
    expect(stackingOrder().at(-1)).toBe('card')
  })
})
