import { afterEach, expect, test } from 'bun:test'
import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { LinearTeamDirectory } from '@ficus/shared'
import { acquireDomHarness } from '../../test/domHarness'
import { integrationQueries } from '../../queryOptions'
import { LinearTeamFilterPicker, LinearTeamRoutingPicker } from './LinearTeamPicker'

const DIRECTORY: LinearTeamDirectory = {
  teams: [
    { id: 'team-des', key: 'DES', name: 'Design', connectionIds: ['app'] },
    { id: 'team-eng', key: 'ENG', name: 'Engineering', connectionIds: ['app', 'key'] },
    { id: 'team-ops', key: 'OPS', name: 'Operations', connectionIds: ['key'] },
  ],
  connections: [
    { id: 'app', displayName: 'Acme app', isDefault: true, status: 'ok' },
    { id: 'key', displayName: 'Ops key', isDefault: false, status: 'ok' },
  ],
}

let dom: Awaited<ReturnType<typeof acquireDomHarness>> | undefined
afterEach(async () => {
  await dom?.cleanup()
  dom = undefined
})

async function render(
  node: (props: { client: QueryClient }) => React.ReactNode,
  directory: LinearTeamDirectory | Error | null = DIRECTORY
) {
  dom = await acquireDomHarness({ url: 'http://localhost/squads/squad/settings' })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const key = integrationQueries.squadLinearTeams('squad').queryKey
  if (directory instanceof Error) {
    // A failed read: the query fetches once and fails, and the picker reports it.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'boom' }), { status: 500 })) as unknown as typeof fetch
  } else if (directory) client.setQueryData(key, directory)
  const { root } = dom.createRoot()
  await dom.act(async () => root.render(<QueryClientProvider client={client}>{node({ client })}</QueryClientProvider>))
  await dom.act(() => new Promise((resolve) => setTimeout(resolve, 0)))
  const doc = dom.window.document
  const button = (text: string) =>
    [...doc.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === text)
  const option = (label: string) =>
    [...doc.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.getAttribute('aria-label') === label)
  const click = (element: HTMLElement) => dom!.act(async () => element.click())
  return { doc, button, option, click }
}

function Routing({ initial, onValue }: { initial: string[]; onValue?: (value: string[]) => void }) {
  const [value, setValue] = useState(initial)
  return (
    <LinearTeamRoutingPicker
      squadId="squad"
      value={value}
      onChange={(next) => {
        onValue?.(next)
        setValue(next)
      }}
    />
  )
}

test('routing lists teams by name and key, selects several, and stores team IDs', async () => {
  const values: string[][] = []
  const { doc, button, option, click } = await render(() => (
    <Routing initial={['team-eng']} onValue={(value) => values.push(value)} />
  ))
  expect(doc.querySelector('[aria-label="Routed Linear teams"]')!.textContent).toContain('EngineeringENG')
  await click(button('Choose teams')!)
  expect([...doc.querySelectorAll('[role="option"]')].map((item) => item.getAttribute('aria-label'))).toEqual([
    'Design',
    'Engineering',
    'Operations',
  ])
  // Two workspaces attached: each option names where the team comes from.
  expect(option('Engineering')!.textContent).toContain('ENG · Acme app, Ops key')
  expect(option('Engineering')!.getAttribute('aria-selected')).toBe('true')
  await click(option('Operations')!)
  await click(option('Design')!)
  expect(values.at(-1)).toEqual(['team-eng', 'team-ops', 'team-des'])
  await click(option('Engineering')!)
  expect(values.at(-1)).toEqual(['team-ops', 'team-des'])
  expect(
    [...doc.querySelectorAll('button[aria-label^="Remove "]')].map((item) => item.getAttribute('aria-label'))
  ).toEqual(['Remove Operations', 'Remove Design'])
})

test('an unknown saved team stays visible, selected and removable instead of being dropped', async () => {
  const values: string[][] = []
  const { doc, button, option, click } = await render(() => (
    <Routing initial={['team-gone', 'team-eng']} onValue={(value) => values.push(value)} />
  ))
  const unknown = doc.querySelector('li[data-team-match="unknown"]')!
  expect(unknown.textContent).toContain('team-gone')
  expect(unknown.textContent).toContain('Unknown team: not found in this squad’s Linear connections')
  await click(button('Choose teams')!)
  expect(option('team-gone')!.getAttribute('aria-selected')).toBe('true')
  // Choosing another team keeps the unknown value saved.
  await click(option('Design')!)
  expect(values.at(-1)).toEqual(['team-gone', 'team-eng', 'team-des'])
  await click(doc.querySelector<HTMLButtonElement>('button[aria-label="Remove team-gone"]')!)
  expect(values.at(-1)).toEqual(['team-eng', 'team-des'])
})

test('a team saved by its key is shown as that team, flagged, and can be switched to its ID', async () => {
  const values: string[][] = []
  const { doc, click } = await render(() => <Routing initial={['eng']} onValue={(value) => values.push(value)} />)
  const row = doc.querySelector('li[data-team-match="key"]')!
  expect(row.textContent).toContain('Engineering')
  expect(row.textContent).toContain('Saved by its key eng. Routing matches team IDs')
  await click([...row.querySelectorAll('button')].find((item) => item.textContent === 'Use the team ID')!)
  expect(values).toEqual([['team-eng']])
  expect(doc.querySelector('li[data-team-match="id"]')!.textContent).toContain('Engineering')
})

test('a failing connection is named beside the teams the others listed', async () => {
  const { doc, button } = await render(() => <Routing initial={[]} />, {
    teams: [DIRECTORY.teams[0]!],
    connections: [
      { id: 'app', displayName: 'Acme app', isDefault: true, status: 'ok' },
      { id: 'key', displayName: 'Ops key', isDefault: false, status: 'error', error: 'invalid_auth' },
      { id: 'big', displayName: 'Big workspace', isDefault: false, status: 'ok', truncated: true },
    ],
  })
  const alert = doc.querySelector('[role="alert"]')!.textContent!
  expect(alert).toContain('Could not list teams for Ops key: Linear refused its credential')
  expect(alert).toContain('Big workspace has more teams than Ficus lists')
  expect(button('Choose teams')).toBeDefined()
  expect(doc.body.textContent).toContain('No teams selected')
})

test('with no attached connection, routing says so and still accepts a team ID by hand', async () => {
  const values: string[][] = []
  const { doc, button, click } = await render(
    () => <Routing initial={['team-old']} onValue={(value) => values.push(value)} />,
    { teams: [], connections: [] }
  )
  expect(doc.body.textContent).toContain('No Linear connection is attached to this squad')
  expect(button('Choose teams')).toBeUndefined()
  expect(doc.querySelector('li[data-team-match="unknown"]')!.textContent).toContain('team-old')
  // Nothing could be listed, so the saved ID is not called unknown.
  expect(doc.querySelector('li[data-team-match="unknown"]')!.textContent).toContain(
    'Its name shows once teams can be listed'
  )
  expect(doc.body.textContent).not.toContain('Unknown team')
  const field = doc.querySelector<HTMLInputElement>('input[aria-label="Linear team ID"]')!
  await dom!.act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom!.window.HTMLInputElement.prototype, 'value')!.set!
    setter.call(field, ' team-new ')
    field.dispatchEvent(new dom!.window.Event('input', { bubbles: true }))
  })
  await click(button('Add team ID')!)
  expect(values).toEqual([['team-old', 'team-new']])
})

test('a failed listing is reported with a retry and keeps the saved teams', async () => {
  const originalFetch = globalThis.fetch
  try {
    const { doc, button } = await render(() => <Routing initial={['team-eng']} />, new Error('down'))
    expect(doc.querySelector('[role="alert"]')!.textContent).toContain('Could not load Linear teams.')
    expect(button('Try again')).toBeDefined()
    expect(doc.querySelector('li[data-team-match="unknown"]')!.textContent).toContain('team-eng')
  } finally {
    globalThis.fetch = originalFetch
  }
})

function Filter({ initial, onValue }: { initial?: string; onValue: (value: string | undefined) => void }) {
  const [value, setValue] = useState(initial)
  return (
    <LinearTeamFilterPicker
      squadId="squad"
      className="field"
      value={value}
      onChange={(next) => {
        onValue(next)
        setValue(next)
      }}
    />
  )
}

test('the rule team filter picks one team by ID, or any team', async () => {
  const values: Array<string | undefined> = []
  const { doc, option, click } = await render(() => <Filter onValue={(value) => values.push(value)} />)
  const trigger = doc.querySelector<HTMLButtonElement>('[role="combobox"]')!
  expect(trigger.textContent).toBe('Any connected team')
  await click(trigger)
  expect(doc.activeElement?.getAttribute('aria-label')).toBe('Search Linear teams')
  await click(option('Operations')!)
  expect(values).toEqual(['team-ops'])
  expect(trigger.textContent).toBe('Operations (OPS)')
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  await click(trigger)
  await click(option('Any connected team')!)
  expect(values).toEqual(['team-ops', undefined])
})

test('the rule team filter shows an unknown saved team instead of clearing it', async () => {
  const { doc, option, click } = await render(() => <Filter initial="team-gone" onValue={() => {}} />)
  const trigger = doc.querySelector<HTMLButtonElement>('[role="combobox"]')!
  expect(trigger.textContent).toBe('Unknown team team-gone')
  await click(trigger)
  expect(option('team-gone')!.getAttribute('aria-selected')).toBe('true')
})
