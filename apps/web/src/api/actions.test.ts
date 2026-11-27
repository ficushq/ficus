import { expect, spyOn, test } from 'bun:test'
import { listPendingActions } from './actions'
import { webTransport } from './transport'

test('the web lists every pending action type, with no type filter', async () => {
  // Restored before the test ends: web test files share one process and this transport.
  const request = spyOn(webTransport, 'request').mockResolvedValue([] as never)
  try {
    await listPendingActions()
    expect(request.mock.calls.map(([path]) => path)).toEqual(['/actions/pending'])
  } finally {
    request.mockRestore()
  }
})
