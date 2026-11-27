import { afterEach, expect, spyOn, test } from 'bun:test'
import { listPendingActions } from './actions'
import { webTransport } from './transport'

const request = spyOn(webTransport, 'request')

afterEach(() => request.mockReset())

test('the web lists every pending action type, with no type filter', async () => {
  request.mockResolvedValue([] as never)
  await listPendingActions()
  expect(request.mock.calls.map(([path]) => path)).toEqual(['/actions/pending'])
})
