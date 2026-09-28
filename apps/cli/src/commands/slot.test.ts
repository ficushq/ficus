import { expect, mock, spyOn, test } from 'bun:test'
import { Command } from 'commander'
import {
  parseSlotCapacity,
  parseSlotDuration,
  parseSlotHistoryLimit,
  registerSlotCommands,
  renderSlotAcquire,
  renderSlotHistory,
  renderSlotPools,
  renderSlotRelease,
  renderSlotRenew,
  renderSlotUnsubscribe,
  resolveSlotSquadId,
  type SlotCommandDependencies,
} from './slot'

test('registers the singular slot command and all ten subcommands', () => {
  const program = new Command()
  registerSlotCommands(program)
  const slot = program.commands.find((command) => command.name() === 'slot')

  expect(slot?.commands.map((command) => command.name()).sort()).toEqual([
    'claim',
    'history',
    'list',
    'register',
    'release',
    'renew',
    'subscribe',
    'unregister',
    'unsubscribe',
    'update',
  ])
  // Pool-scoped commands still need a squad; UUID-addressed ones resolve it
  // server-side from the claim/waiter id, so they must NOT ask for it.
  const squadScoped = ['list', 'history', 'register', 'update', 'unregister', 'claim', 'subscribe']
  const uuidAddressed = ['renew', 'release', 'unsubscribe']
  for (const name of squadScoped) {
    const command = slot?.commands.find((entry) => entry.name() === name)
    expect(command?.options.some((option) => option.long === '--squad')).toBe(true)
  }
  for (const name of uuidAddressed) {
    const command = slot?.commands.find((entry) => entry.name() === name)
    expect(command?.options.some((option) => option.long === '--squad')).toBe(false)
    expect(command?.registeredArguments.map((argument) => argument.name())).toEqual([
      name === 'unsubscribe' ? 'waiter-id' : 'claim-id',
    ])
  }
  const claim = slot?.commands.find((entry) => entry.name() === 'claim')
  expect(claim?.options.some((option) => option.long === '--no-subscribe')).toBe(true)
})

test('command actions call the exact encoded squad API paths and bodies', async () => {
  const calls: Array<{ method: string; path: string; body?: unknown }> = []
  const responseFor = (path: string) => {
    if (path.includes('/history')) return { items: [], hasMore: false, nextCursor: null }
    if (path.endsWith('/renew')) {
      return { outcome: 'renewed', message: 'renewed', claimId: 'claim', expiresAt: '2026-09-03T01:00:00Z' }
    }
    if (path.includes('/claims/') && !path.endsWith('/renew')) {
      return { outcome: 'released', message: 'released', claimId: 'claim' }
    }
    if (path.endsWith('/claims')) {
      return {
        outcome: 'granted',
        message: 'granted',
        pool: { key: 'heavy/tests' },
        claim: { id: 'claim', expiresAt: '2026-09-03T01:00:00Z' },
      }
    }
    if (path.endsWith('/waiters')) {
      return {
        outcome: 'queued',
        message: 'queued',
        pool: { key: 'heavy/tests' },
        waiter: { id: 'waiter' },
      }
    }
    if (path.includes('/waiters/')) return { outcome: 'canceled', message: 'canceled', waiterId: 'waiter' }
    return {}
  }
  const dependencies = {
    apiGet: mock(async (path: string) => {
      calls.push({ method: 'GET', path })
      return responseFor(path)
    }),
    apiPost: mock(async (path: string, body: unknown) => {
      calls.push({ method: 'POST', path, body })
      return responseFor(path)
    }),
    apiPatch: mock(async (path: string, body: unknown) => {
      calls.push({ method: 'PATCH', path, body })
      return responseFor(path)
    }),
    apiDelete: mock(async (path: string) => {
      calls.push({ method: 'DELETE', path })
      return responseFor(path)
    }),
    output: mock(() => {}),
  } as unknown as SlotCommandDependencies
  const claimId = '11111111-1111-4111-8111-111111111111'
  const waiterId = '22222222-2222-4222-8222-222222222222'
  const cases: Array<{ args: string[]; expected: (typeof calls)[number] }> = [
    { args: ['list'], expected: { method: 'GET', path: '/api/squads/squad%2Fone/slots' } },
    {
      args: ['list', 'heavy/tests'],
      expected: { method: 'GET', path: '/api/squads/squad%2Fone/slots/heavy%2Ftests' },
    },
    {
      args: ['history', 'heavy-tests', '--limit', '25', '--cursor', 'opaque'],
      expected: {
        method: 'GET',
        path: '/api/squads/squad%2Fone/slots/heavy-tests/history?limit=25&cursor=opaque',
      },
    },
    {
      args: ['register', 'heavy/tests', '--capacity', '2', '--timeout', '1h'],
      expected: {
        method: 'POST',
        path: '/api/squads/squad%2Fone/slots',
        body: { key: 'heavy/tests', capacity: 2, claimTimeoutMs: 3_600_000 },
      },
    },
    {
      args: ['update', 'heavy/tests', '--capacity', '3'],
      expected: { method: 'PATCH', path: '/api/squads/squad%2Fone/slots/heavy%2Ftests', body: { capacity: 3 } },
    },
    {
      args: ['unregister', 'heavy/tests'],
      expected: { method: 'DELETE', path: '/api/squads/squad%2Fone/slots/heavy%2Ftests' },
    },
    {
      args: ['claim', 'heavy/tests'],
      expected: { method: 'POST', path: '/api/squads/squad%2Fone/slots/heavy%2Ftests/claims', body: {} },
    },
    {
      args: ['renew', claimId],
      expected: { method: 'POST', path: `/api/slots/claims/${claimId}/renew`, body: {} },
    },
    {
      args: ['release', claimId],
      expected: { method: 'DELETE', path: `/api/slots/claims/${claimId}` },
    },
    {
      args: ['claim', 'heavy/tests', '--no-subscribe'],
      expected: {
        method: 'POST',
        path: '/api/squads/squad%2Fone/slots/heavy%2Ftests/claims?subscribe=false',
        body: {},
      },
    },
    {
      args: ['subscribe', 'heavy/tests'],
      expected: { method: 'POST', path: '/api/squads/squad%2Fone/slots/heavy%2Ftests/waiters', body: {} },
    },
    {
      args: ['unsubscribe', waiterId],
      expected: { method: 'DELETE', path: `/api/slots/waiters/${waiterId}` },
    },
  ]

  for (const { args, expected } of cases) {
    const program = new Command()
    registerSlotCommands(program, dependencies)
    const squadArgs = expected.path.startsWith('/api/slots/') ? [] : ['--squad', 'squad/one']
    await program.parseAsync(['node', 'tau', 'slot', ...args, ...squadArgs])
    expect(calls.at(-1)).toEqual(expected)
  }
})

test('command actions use FICUS_SQUAD_ID when explicit squad is absent', async () => {
  const prior = process.env.FICUS_SQUAD_ID
  process.env.FICUS_SQUAD_ID = 'environment-squad'
  let path = ''
  const dependencies = {
    apiGet: async (value: string) => {
      path = value
      return []
    },
    apiPost: async () => ({}),
    apiPatch: async () => ({}),
    apiDelete: async () => ({}),
    output: () => {},
  } as unknown as SlotCommandDependencies
  try {
    const program = new Command()
    registerSlotCommands(program, dependencies)
    await program.parseAsync(['node', 'tau', 'slot', 'list'])
    expect(path).toBe('/api/squads/environment-squad/slots')
  } finally {
    if (prior === undefined) delete process.env.FICUS_SQUAD_ID
    else process.env.FICUS_SQUAD_ID = prior
  }
})

test('unavailable is a successful authoritative command outcome', async () => {
  const unavailable = { outcome: 'unavailable' as const, message: 'full', pool: { key: 'tests' } }
  let rendered: unknown
  const dependencies = {
    apiGet: async () => ({}),
    apiPost: async () => unavailable,
    apiPatch: async () => ({}),
    apiDelete: async () => ({}),
    output: (value: unknown) => {
      rendered = value
    },
  } as unknown as SlotCommandDependencies
  const program = new Command()
  registerSlotCommands(program, dependencies)

  await expect(
    program.parseAsync(['node', 'tau', 'slot', 'claim', 'tests', '--squad', 'squad-id'])
  ).resolves.toBeDefined()
  expect(rendered).toBe(unavailable)
})

test('history passes the complete server page to output unchanged', async () => {
  const response = {
    items: [
      {
        kind: 'claim' as const,
        id: 'claim-id',
        ownerAgentId: 'owner-id',
        ownerShortId: 'owner-id',
        status: 'released',
        reason: 'released',
        endedAt: '2026-09-05T08:00:00.000Z',
      },
    ],
    hasMore: true,
    nextCursor: 'opaque',
  }
  let received: unknown
  let human = ''
  const dependencies = {
    apiGet: async () => response,
    apiPost: async () => ({}),
    apiPatch: async () => ({}),
    apiDelete: async () => ({}),
    output: (value: unknown, rendered?: string) => {
      received = value
      human = rendered ?? ''
    },
  } as unknown as SlotCommandDependencies
  const program = new Command()
  registerSlotCommands(program, dependencies)

  await program.parseAsync(['node', 'tau', 'slot', 'history', 'tests', '--squad', 'squad'])

  expect(received).toBe(response)
  expect(human).toContain('claim claim-id')
  expect(human).toContain('More: ficus slot history tests --squad squad --limit 50 --cursor opaque')
})

test('passes the complete server object to output unchanged', async () => {
  const response = { nested: { stable: true }, outcomes: ['released', 'expired'] }
  let rendered: unknown
  const dependencies = {
    apiGet: async () => response,
    apiPost: async () => ({}),
    apiPatch: async () => ({}),
    apiDelete: async () => ({}),
    output: (value: unknown) => {
      rendered = value
    },
  } as unknown as SlotCommandDependencies
  const program = new Command()
  registerSlotCommands(program, dependencies)
  await program.parseAsync(['node', 'tau', 'slot', 'list', '--squad', 'squad'])
  expect(rendered).toBe(response)
})

test('a command without squad context fails before making an API call', async () => {
  const prior = process.env.FICUS_SQUAD_ID
  delete process.env.FICUS_SQUAD_ID
  const apiGet = mock(async () => [])
  const dependencies = {
    apiGet,
    apiPost: async () => ({}),
    apiPatch: async () => ({}),
    apiDelete: async () => ({}),
    output: () => {},
  } as unknown as SlotCommandDependencies
  const error = spyOn(console, 'error').mockImplementation(() => {})
  const exit = spyOn(process, 'exit').mockImplementation((() => undefined) as never)
  try {
    const program = new Command()
    registerSlotCommands(program, dependencies)
    await program.parseAsync(['node', 'tau', 'slot', 'list'])
    expect(apiGet).not.toHaveBeenCalled()
  } finally {
    error.mockRestore()
    exit.mockRestore()
    if (prior !== undefined) process.env.FICUS_SQUAD_ID = prior
  }
})

test('resolves explicit squad before environment and errors without either', () => {
  expect(resolveSlotSquadId('explicit', 'environment')).toBe('explicit')
  expect(resolveSlotSquadId(undefined, 'environment')).toBe('environment')
  expect(() => resolveSlotSquadId(undefined, '')).toThrow(/--squad.*FICUS_SQUAD_ID/)
})

test('parses bounded slot capacity', () => {
  expect(parseSlotCapacity('1')).toBe(1)
  expect(parseSlotCapacity('1000')).toBe(1000)
  expect(() => parseSlotCapacity('0')).toThrow()
  expect(() => parseSlotCapacity('1001')).toThrow()
})

test('parses bounded slot history limits', () => {
  expect(parseSlotHistoryLimit('1')).toBe(1)
  expect(parseSlotHistoryLimit('100')).toBe(100)
  for (const invalid of ['0', '101', '1.5', 'Infinity', '']) {
    expect(() => parseSlotHistoryLimit(invalid)).toThrow()
  }
})

test('parses bounded slot durations', () => {
  expect(parseSlotDuration('1h')).toBe(3_600_000)
  expect(parseSlotDuration('60s')).toBe(60_000)
  expect(() => parseSlotDuration('30s')).toThrow()
  expect(() => parseSlotDuration('2d')).toThrow()
})

test('renders actionable acquire outcomes with mandatory release guidance', () => {
  const pool = { key: 'tests' }
  expect(
    renderSlotAcquire(
      {
        outcome: 'granted',
        message: 'granted',
        pool,
        claim: { id: 'claim-id', expiresAt: '2026-09-03T04:00:00Z' },
      },
      'squad-id'
    )
  ).toContain('YOU MUST RELEASE THIS CLAIM AS SOON AS YOU ARE DONE.')
  expect(renderSlotAcquire({ outcome: 'unavailable', message: 'unavailable', pool }, 'squad-id')).toContain(
    'ficus slot subscribe tests --squad squad-id'
  )
  const queued = renderSlotAcquire(
    { outcome: 'queued', message: 'queued', pool, waiter: { id: 'waiter-id' } },
    'squad-id'
  )
  expect(queued).toContain('ficus slot unsubscribe waiter-id')
  // Queued is NOT ownership: the merged claim flow makes this the common
  // outcome, so it has to say so as loudly as the granted case says the opposite.
  expect(queued).toContain('YOU DO NOT OWN CAPACITY YET.')
  expect(queued).not.toContain('--squad')
})

test('renders compact terminal history and an empty state', () => {
  expect(renderSlotHistory({ items: [], hasMore: false, nextCursor: null }, 'tests', 'squad', 50)).toBe(
    'No terminal slot history.'
  )
  const rendered = renderSlotHistory(
    {
      items: [
        {
          kind: 'waiter',
          id: 'waiter-id',
          ownerAgentId: 'owner-id',
          ownerShortId: 'owner-sh',
          status: 'canceled',
          reason: 'canceled',
          endedAt: '2026-09-05T08:00:00.000Z',
        },
      ],
      hasMore: false,
      nextCursor: null,
    },
    'tests',
    'squad',
    50
  )
  expect(rendered).toContain('waiter waiter-id')
  expect(rendered).toContain('owner-sh')
  expect(rendered).not.toContain('Release:')
  expect(rendered).not.toContain('Renew:')
})

test('renders compact actionable slot list and detail output', () => {
  const summary = {
    key: 'heavy-tests',
    capacity: 2,
    activeCount: 1,
    availableCount: 1,
    queuedCount: 3,
  }
  expect(renderSlotPools([summary], 'squad')).toBe('heavy-tests: 1/2 active, 1 available, 3 queued')
  expect(renderSlotPools([], 'squad')).toBe('No slot pools registered.')
  expect(
    renderSlotPools(
      {
        ...summary,
        oldestWaiterAgeMs: 4200,
        callerClaim: { id: 'claim-id', expiresAt: '2026-09-03T03:00:00Z' },
        callerWaiter: { id: 'waiter-id' },
      },
      'squad-id'
    )
  ).toContain('Release: ficus slot release claim-id')
  expect(renderSlotPools({ ...summary, callerWaiter: { id: 'waiter-id' } }, 'squad-id')).toContain(
    'Unsubscribe: ficus slot unsubscribe waiter-id'
  )
})

test('renders renewal only when the authoritative outcome is renewed', () => {
  expect(
    renderSlotRenew({
      outcome: 'renewed',
      message: 'renewed',
      claimId: 'claim-id',
      expiresAt: '2026-09-03T01:00:00Z',
    })
  ).toContain('Renewed claim claim-id')

  for (const outcome of ['expired', 'already_released'] as const) {
    const text = renderSlotRenew({
      outcome,
      message: `claim is ${outcome}`,
      claimId: 'claim-id',
      expiresAt: '2026-09-03T01:00:00Z',
    })
    expect(text).toContain(`claim is ${outcome}`)
    expect(text).toContain('NO LONGER OWN')
    expect(text).not.toContain('Renewed claim')
  }
})

test('renders release terminal outcomes without falsely claiming ownership was released now', () => {
  expect(renderSlotRelease({ outcome: 'released', message: 'released', claimId: 'claim-id' })).toBe('released')
  for (const outcome of ['expired', 'already_released'] as const) {
    const text = renderSlotRelease({ outcome, message: `claim is ${outcome}`, claimId: 'claim-id' })
    expect(text).toContain(`claim is ${outcome}`)
    expect(text).toContain('NO LONGER OWN')
    expect(text).not.toContain('Released claim')
  }
})

test('warns about a live claim only while that claim is actually active', () => {
  expect(
    renderSlotUnsubscribe({
      outcome: 'already_granted',
      message: 'waiter was promoted',
      waiterId: 'waiter-id',
      claimId: 'claim-id',
      claimStatus: 'active',
    })
  ).toBe(
    'waiter was promoted\nYOU OWN A LIVE CLAIM AND MUST RELEASE IT AS SOON AS YOU ARE DONE.\nClaim ID: claim-id\nRelease: ficus slot release claim-id'
  )

  // The bug this fixes: a granted waiter whose claim has since ended was still
  // told it owned live capacity and sent to release a claim that was gone.
  for (const claimStatus of ['released', 'expired'] as const) {
    const text = renderSlotUnsubscribe({
      outcome: 'already_granted',
      message: `claim is ${claimStatus}`,
      waiterId: 'waiter-id',
      claimId: 'claim-id',
      claimStatus,
    })
    expect(text).toBe(`claim is ${claimStatus}\nYOU NO LONGER OWN THIS SLOT CAPACITY.`)
    expect(text).not.toContain('YOU OWN A LIVE CLAIM')
    expect(text).not.toContain('ficus slot release')
  }

  // An older server omits claimStatus; never drop the warning in that case.
  expect(
    renderSlotUnsubscribe({
      outcome: 'already_granted',
      message: 'waiter was promoted',
      waiterId: 'waiter-id',
      claimId: 'claim-id',
    })
  ).toContain('YOU OWN A LIVE CLAIM')

  expect(renderSlotUnsubscribe({ outcome: 'canceled', message: 'canceled', waiterId: 'waiter-id' })).toBe('canceled')
})

test('list rendering surfaces the caller recovery state for every pool', () => {
  const foreignHolderOnly = {
    key: 'builds',
    capacity: 1,
    activeCount: 1,
    availableCount: 0,
    queuedCount: 2,
    holders: [{ ownerShortId: 'abcd1234' }],
  }
  const withClaim = {
    key: 'tests',
    capacity: 1,
    activeCount: 1,
    availableCount: 0,
    queuedCount: 0,
    holders: [{ ownerShortId: 'abcd1234' }],
    callerClaim: { id: 'claim-id', expiresAt: '2026-09-03T03:00:00Z' },
  }
  const withWaiter = {
    key: 'deploys',
    capacity: 2,
    activeCount: 2,
    availableCount: 0,
    queuedCount: 1,
    holders: [],
    callerWaiter: { id: 'waiter-id', queuedAt: '2026-09-03T02:00:00Z' },
  }

  const text = renderSlotPools([foreignHolderOnly, withClaim, withWaiter], 'squad-id')

  expect(text).toContain('builds: 1/1 active, 0 available, 2 queued')
  expect(text).toContain('tests: 1/1 active, 0 available, 0 queued')
  expect(text).toContain('Your claim: claim-id')
  expect(text).toContain('Expires: 2026-09-03T03:00:00Z')
  expect(text).toContain('Release: ficus slot release claim-id')
  expect(text).toContain('Renew: ficus slot renew claim-id')
  expect(text).toContain('deploys: 2/2 active, 0 available, 1 queued')
  expect(text).toContain('Your waiter: waiter-id')
  expect(text).toContain('Queued: 2026-09-03T02:00:00Z')
  expect(text).toContain('Unsubscribe: ficus slot unsubscribe waiter-id')
  // Foreign holder identity is never surfaced in human output.
  expect(text).not.toContain('abcd1234')
})

test('list rendering keeps foreign pools to a single summary line', () => {
  const pool = {
    key: 'tests',
    capacity: 2,
    activeCount: 1,
    availableCount: 1,
    queuedCount: 3,
    holders: [{ id: 'foreign-claim', ownerShortId: 'abcd1234' }],
  }
  expect(renderSlotPools([pool], 'squad')).toBe('tests: 1/2 active, 1 available, 3 queued')
})

test('administration commands render the authoritative server outcome and message', async () => {
  const responses = {
    register: {
      outcome: 'registered' as const,
      message: 'Slot pool "tests" is registered with capacity 2 and a 2m claim timeout.',
      pool: { key: 'tests', capacity: 2 },
    },
    update: {
      outcome: 'updated' as const,
      message: 'Slot pool "tests" now has capacity 3.',
      pool: { key: 'tests', capacity: 3 },
    },
    unregister: {
      outcome: 'unregistered' as const,
      message: 'Slot pool "tests" is unregistered. Terminal history is retained for bounded recovery.',
      pool: { key: 'tests' },
    },
  }
  const outputs: Array<{ data: unknown; message?: string }> = []
  const dependencies = {
    apiGet: async () => ({}),
    apiPost: async () => responses.register,
    apiPatch: async () => responses.update,
    apiDelete: async () => responses.unregister,
    output: (data: unknown, message?: string) => {
      outputs.push({ data, message })
    },
  } as unknown as SlotCommandDependencies

  const program = new Command()
  registerSlotCommands(program, dependencies)
  await program.parseAsync(['node', 'tau', 'slot', 'register', 'tests', '--squad', 'squad-id'])
  await program.parseAsync(['node', 'tau', 'slot', 'update', 'tests', '--capacity', '3', '--squad', 'squad-id'])
  await program.parseAsync(['node', 'tau', 'slot', 'unregister', 'tests', '--squad', 'squad-id'])

  expect(outputs.map((entry) => entry.message)).toEqual([
    responses.register.message,
    responses.update.message,
    responses.unregister.message,
  ])
  // JSON output receives the untouched server response object.
  expect(outputs.map((entry) => entry.data)).toEqual([responses.register, responses.update, responses.unregister])
})

test('administration commands reject responses without a stable outcome field', async () => {
  const legacyRow = { key: 'tests', capacity: 2 }
  const outputs: unknown[] = []
  const dependencies = {
    apiGet: async () => ({}),
    apiPost: async () => legacyRow,
    apiPatch: async () => legacyRow,
    apiDelete: async () => legacyRow,
    output: (data: unknown) => {
      outputs.push(data)
    },
  } as unknown as SlotCommandDependencies

  const program = new Command()
  registerSlotCommands(program, dependencies)
  for (const args of [
    ['register', 'tests'],
    ['update', 'tests', '--capacity', '3'],
    ['unregister', 'tests'],
  ]) {
    await program.parseAsync(['node', 'tau', 'slot', ...args, '--squad', 'squad-id'])
  }
  expect(outputs).toEqual([])
})
