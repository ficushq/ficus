import { expect, test } from 'bun:test'
import { formatApiErrorPayload } from './client-errors'

test('formats bounded authoritative integration usage conflicts', () => {
  const message = formatApiErrorPayload(
    {
      error: 'Integration connection is assigned to squads',
      usage: {
        squadCount: 2,
        squads: [
          { id: 'a', name: 'Alpha' },
          { id: 'b', name: 'Beta' },
        ],
      },
    },
    'Request failed: 409'
  )
  expect(message).toBe('Integration connection is assigned to squads. Used by 2 squads: Alpha, Beta')
  expect(message.length).toBeLessThanOrEqual(500)
})

// The CLI preload replaces client.ts for command tests. A child exercises the real
// HTTP boundary without inheriting those module mocks; fetch stays entirely local.
test('preserves structured error payloads and legacy fallbacks across the real client boundary', () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      '-e',
      `
    import { strict as assert } from 'node:assert'
    import { apiPost } from './src/client.ts'
    import { ApiRequestError } from './src/client-errors.ts'
    import { runDerivation } from './src/commands/voice.ts'
    const payload = { error: 'derivation_too_few_samples', counts: { kept: 2, collected: 10 }, minimum: 8 }
    globalThis.fetch = async () => Response.json(payload, { status: 422 })
    await assert.rejects(apiPost('/fixture'), error => {
      assert(error instanceof ApiRequestError)
      assert.equal(error.code, payload.error)
      assert.equal(error.status, 422)
      assert.deepEqual(error.payload, payload)
      return true
    })
    for (const [code, sentence] of [
      ['derivation_github_unavailable', 'GitHub is unavailable'],
      ['derivation_login_not_visible', 'not found or is not visible'],
      ['derivation_too_few_samples', 'kept 2 of 10 collected; at least 8'],
      ['derivation_invalid_output', 'overlapped private sample text'],
      ['derivation_model_unavailable', 'model is unavailable'],
    ]) {
      globalThis.fetch = async () => Response.json({ ...payload, error: code, reason: 'private_text_in_base' }, { status: 422 })
      await assert.rejects(runDerivation('fixture', { github: 'octocat' }), error => {
        assert(error.message.startsWith(code + ': '))
        assert(error.message.includes(sentence))
        return true
      })
    }
    globalThis.fetch = async () => Response.json({ code: 'forbidden', error: 'Permission denied' }, { status: 403 })
    await assert.rejects(apiPost('/fixture'), error => error.code === 'forbidden' && error.message === 'Permission denied')
    for (const body of ['<html>Bad gateway</html>', 'null']) {
      globalThis.fetch = async () => new Response(body, { status: 502 })
      await assert.rejects(apiPost('/fixture'), error => error.message === 'Request failed: 502')
    }
    const network = new Error('Network disconnected')
    globalThis.fetch = async () => { throw network }
    await assert.rejects(apiPost('/fixture'), error => error === network)
    globalThis.fetch = async () => Response.json({ draft: { base: 'Synthetic draft.' } })
    assert.deepEqual(await apiPost('/fixture'), { draft: { base: 'Synthetic draft.' } })
  `,
    ],
    { cwd: new URL('..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe' }
  )
  expect(result.stderr.toString()).toBe('')
  expect(result.exitCode).toBe(0)
})
