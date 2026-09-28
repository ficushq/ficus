import { describe, expect, it } from 'bun:test'
import { BOX_USER_HEADERS, boxUserHeaders } from './box-user'

describe('box-user header names', () => {
  it('sends the Ficus name first and the pre-Ficus name for the cutover window', () => {
    // Running boxes and the shared machine image outlive a Core upgrade, and a
    // rollback pairs an older Core with a newer image, so senders set both.
    expect(BOX_USER_HEADERS).toEqual(['x-ficus-box-user', 'x-tau-box-user']) // K3
  })

  it('builds one entry per name, all with the same value', () => {
    const headers = boxUserHeaders('box_abcdef012345')
    expect(Object.keys(headers)).toEqual([...BOX_USER_HEADERS])
    expect(new Set(Object.values(headers))).toEqual(new Set(['box_abcdef012345']))
  })
})
