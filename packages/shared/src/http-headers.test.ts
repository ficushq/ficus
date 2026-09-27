import { describe, expect, it } from 'bun:test'
import { CSRF_HEADER } from './http-headers'

describe('browser client headers', () => {
  it('the CSRF header is x-ficus-csrf', () => {
    expect(CSRF_HEADER).toBe('x-ficus-csrf')
  })
})
