import { describe, expect, test } from 'bun:test'
import { ProductFeedbackError, ProductFeedbackService } from './product-feedback'

const CLOUD_TOKEN = 'synthetic-cloud-tenant-credential'
const RELAY_TOKEN = `ficus_pri_00000000-0000-4000-8000-000000000001_${'s'.repeat(43)}`
const REPORT_ID = '11111111-1111-4111-8111-111111111111'

interface Call {
  url: string
  init: RequestInit
}

function setup(
  options: {
    managed?: boolean
    relay?: { baseUrl: string; token: string } | null | 'throws'
    cloud?: { baseUrl: string; token: string } | 'throws'
    respond?: () => Response | Promise<Response>
  } = {}
) {
  const calls: Call[] = []
  const service = new ProductFeedbackService({
    managed: () => options.managed ?? false,
    cloudConfig: () => {
      if (options.cloud === 'throws') throw new Error('unconfigured')
      return options.cloud ?? { baseUrl: 'https://platform.example.test', token: CLOUD_TOKEN }
    },
    relayConfig: () => {
      if (options.relay === 'throws') throw new Error(`malformed ${RELAY_TOKEN}`)
      return options.relay === undefined ? { baseUrl: 'https://relay.example.test', token: RELAY_TOKEN } : options.relay
    },
    fetch: async (url, init) => {
      calls.push({ url, init })
      return options.respond ? options.respond() : Response.json({ id: REPORT_ID }, { status: 201 })
    },
    coreVersion: '9.9.9-test',
  })
  return { service, calls }
}

const report = { category: 'bug' as const, message: 'The settings page shows a blank panel.' }

async function sendError(service: ProductFeedbackService) {
  try {
    await service.send(report)
  } catch (error) {
    return error as ProductFeedbackError
  }
  throw new Error('expected send to fail')
}

describe('credential selection', () => {
  test('Ficus Cloud sends the tenant credential to the platform base URL', async () => {
    const { service, calls } = setup({ managed: true })
    expect(await service.send(report)).toEqual({ id: REPORT_ID })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://platform.example.test/api/instance-feedback')
    expect(new Headers(calls[0].init.headers).get('authorization')).toBe(`Bearer ${CLOUD_TOKEN}`)
    expect(calls[0].init.redirect).toBe('error')
  })

  test('self-hosted sends the Connect Ficus account credential to the relay base URL', async () => {
    const { service, calls } = setup()
    await service.send(report)
    expect(calls[0].url).toBe('https://relay.example.test/api/instance-feedback')
    expect(new Headers(calls[0].init.headers).get('authorization')).toBe(`Bearer ${RELAY_TOKEN}`)
  })

  test('Cloud never falls back to a relay credential', async () => {
    const { service, calls } = setup({ managed: true, cloud: 'throws' })
    const error = await sendError(service)
    expect(error.code).toBe('unavailable')
    expect(calls).toHaveLength(0)
  })

  test('refuses a base URL that is not https', async () => {
    const { service, calls } = setup({ relay: { baseUrl: 'http://relay.example.test', token: RELAY_TOKEN } })
    expect((await sendError(service)).code).toBe('unavailable')
    expect(calls).toHaveLength(0)
  })
})

describe('request body', () => {
  test('sends the report, submitter and only version and page as context', async () => {
    const { service, calls } = setup()
    await service.send({ ...report, submitter: { name: 'Ada Example', email: 'ada@example.test' }, page: '/settings' })
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      category: 'bug',
      message: report.message,
      submitter: { name: 'Ada Example', email: 'ada@example.test' },
      context: { coreVersion: '9.9.9-test', page: '/settings' },
    })
  })

  test('omits submitter entirely when none is given', async () => {
    const { service, calls } = setup()
    await service.send({ ...report, submitter: {} })
    const body = JSON.parse(String(calls[0].init.body))
    expect(body).not.toHaveProperty('submitter')
    expect(body.context).toEqual({ coreVersion: '9.9.9-test' })
  })
})

describe('status', () => {
  test('Cloud is always connected', () => {
    expect(setup({ managed: true, cloud: 'throws' }).service.status()).toEqual({ connected: true, managed: true })
  })

  test('self-hosted is connected only with a credential', () => {
    expect(setup().service.status()).toEqual({ connected: true, managed: false })
    expect(setup({ relay: null }).service.status()).toEqual({ connected: false, managed: false })
    expect(setup({ relay: 'throws' }).service.status()).toEqual({ connected: false, managed: false })
  })

  test('never contains the credential', () => {
    expect(JSON.stringify(setup().service.status())).not.toContain(RELAY_TOKEN)
  })
})

describe('error mapping', () => {
  test('a self-hosted instance without a connection is not connected and sends nothing', async () => {
    const { service, calls } = setup({ relay: null })
    const error = await sendError(service)
    expect(error).toBeInstanceOf(ProductFeedbackError)
    expect([error.code, error.status]).toEqual(['not_connected', 409])
    expect(calls).toHaveLength(0)
  })

  test.each([
    [false, 401, 'not_connected', 409],
    [true, 401, 'unavailable', 503],
    [false, 429, 'rate_limited', 429],
    [false, 400, 'unavailable', 503],
    [false, 413, 'unavailable', 503],
    [false, 503, 'unavailable', 503],
    [false, 200, 'unavailable', 503],
  ] as const)('managed=%p platform %p maps to %p (%p)', async (managed, status, code, httpStatus) => {
    const { service } = setup({
      managed,
      respond: () =>
        Response.json({ error: `platform detail ${CLOUD_TOKEN} ${RELAY_TOKEN}`, id: REPORT_ID }, { status }),
    })
    const error = await sendError(service)
    expect([error.code, error.status]).toEqual([code, httpStatus])
    expect(error.message).not.toContain('platform detail')
    expect(error.message).not.toContain(RELAY_TOKEN)
    expect(error.message).not.toContain(CLOUD_TOKEN)
  })

  test('network failures and malformed success bodies are unavailable without detail', async () => {
    const network = setup({
      respond: () => {
        throw new Error(`connect failed with ${RELAY_TOKEN}`)
      },
    })
    const networkError = await sendError(network.service)
    expect(networkError.code).toBe('unavailable')
    expect(networkError.message).not.toContain(RELAY_TOKEN)

    const malformed = setup({ respond: () => Response.json({ id: 'not-a-uuid' }, { status: 201 }) })
    expect((await sendError(malformed.service)).code).toBe('unavailable')
  })
})
