import { describe, expect, it } from 'bun:test'
import { BOX_USER_HEADERS, boxUserHeaders } from './box-user'

describe('box-user header names', () => {
  it('sends the Ficus name only', () => {
    expect(BOX_USER_HEADERS).toEqual(['x-ficus-box-user'])
  })

  it('builds one entry per name, all with the same value', () => {
    const headers = boxUserHeaders('box_abcdef012345')
    expect(Object.keys(headers)).toEqual([...BOX_USER_HEADERS])
    expect(new Set(Object.values(headers))).toEqual(new Set(['box_abcdef012345']))
  })
})
