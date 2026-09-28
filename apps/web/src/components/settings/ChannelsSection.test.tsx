import { useState } from 'react'
import { ChannelIdsEditor } from './ChannelIdsEditor'
import { ChannelLinkCommand } from './LinkedChatAccounts'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { renderToString } from 'react-dom/server'
import { queryKeys } from '../../queryKeys'
import { acquireDomHarness } from '../../test/domHarness'
import type { ChannelInstanceConfig } from '../../api/config'
import { listSquads } from '../../api/squads'
import { ChannelApiProvider, type ChannelApi } from './channelApi'
import { SquadsApiProvider, useSquadsApi, type SquadsApi } from './squadsApi'
import { AddChannelForm, ChannelRow } from './ChannelsSection'

const createChannelInstanceCalls: unknown[] = []
const updateChannelInstanceCalls: Array<{ id: string; data: unknown }> = []
const channelApi: Partial<ChannelApi> = {
  createChannelInstance: async (data) => {
    createChannelInstanceCalls.push(data)
    return { id: 'created', name: 'x', provider: 'discord' } as ChannelInstanceConfig
  },
  updateChannelInstance: async (id, data) => {
    updateChannelInstanceCalls.push({ id, data })
    return { id, name: 'x', provider: 'discord' } as ChannelInstanceConfig
  },
}

const activeQueryClients = new Set<QueryClient>()
let dom: Awaited<ReturnType<typeof acquireDomHarness>>

beforeEach(async () => {
  dom = await acquireDomHarness({
    url: 'http://localhost/settings/channels',
    beforeUnmount: async () => {
      await Promise.all([...activeQueryClients].map((client) => client.cancelQueries()))
      for (const client of activeQueryClients) client.clear()
      activeQueryClients.clear()
    },
  })
  Object.assign(dom.window, { SyntaxError })
})

afterEach(async () => {
  createChannelInstanceCalls.length = 0
  updateChannelInstanceCalls.length = 0
  await dom.cleanup()
})

const SQUADS = [
  { id: 'squad-a', name: 'Squad A' },
  { id: 'squad-b', name: 'Squad B' },
]

async function renderComponent(node: React.ReactElement) {
  const window = dom.window
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  activeQueryClients.add(queryClient)
  queryClient.setQueryData(queryKeys.squads.list(), SQUADS)
  const { root } = dom.createRoot()
  await dom.act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <ChannelApiProvider api={channelApi}>{node}</ChannelApiProvider>
      </QueryClientProvider>
    )
  })
  return { window, queryClient }
}

async function click(window: typeof dom.window, el: Element) {
  await dom.act(async () => {
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    // React Query batches mutation notifications on the next macrotask. Drain
    // that scheduler boundary inside act, rather than leaking it into the next action.
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  })
}

async function typeInput(window: typeof dom.window, el: HTMLInputElement, value: string) {
  await dom.act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    valueSetter?.call(el, value)
    el.dispatchEvent(new window.InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }))
    el.dispatchEvent(new window.Event('change', { bubbles: true }))
  })
}

async function selectOption(window: typeof dom.window, select: HTMLSelectElement, value: string) {
  await dom.act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set
    setter?.call(select, value)
    select.dispatchEvent(new window.Event('change', { bubbles: true }))
  })
}

function SquadsContractProbe({ expectedDefault }: { expectedDefault?: typeof listSquads }) {
  const api = useSquadsApi()
  const query = useQuery({ queryKey: ['squads-contract-probe'], queryFn: () => api.listSquads() })
  if (expectedDefault) return <span>{api.listSquads === expectedDefault ? 'real-default' : 'replaced-default'}</span>
  if (!query.data) return <span>loading</span>
  return <span>{Array.isArray(query.data) ? 'array' : `foreign:${Object.keys(query.data).join(',')}`}</span>
}

async function renderLiveIsolationPair(order: 'valid-first' | 'foreign-first') {
  const window = dom.window
  const { root: validRoot, container: validElement } = dom.createRoot()
  const { root: foreignRoot, container: foreignElement } = dom.createRoot()
  const validClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const foreignClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  activeQueryClients.add(validClient)
  activeQueryClients.add(foreignClient)
  const validApi: Partial<SquadsApi> = { listSquads: async () => SQUADS as never }
  const foreignApi: Partial<SquadsApi> = { listSquads: async () => ({ squads: SQUADS }) as never }
  const renderValid = () =>
    validRoot.render(
      <QueryClientProvider client={validClient}>
        <SquadsApiProvider api={validApi}>
          <AddChannelForm onClose={() => {}} onCreated={() => {}} />
        </SquadsApiProvider>
      </QueryClientProvider>
    )
  const renderForeign = () =>
    foreignRoot.render(
      <QueryClientProvider client={foreignClient}>
        <SquadsApiProvider api={foreignApi}>
          <SquadsContractProbe />
        </SquadsApiProvider>
      </QueryClientProvider>
    )

  await dom.act(async () => {
    if (order === 'valid-first') {
      renderValid()
      renderForeign()
    } else {
      renderForeign()
      renderValid()
    }
  })
  await click(window, validElement.querySelector('input[type="radio"][value="discord"]') as HTMLInputElement)
  await dom.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return { window, validElement, foreignElement }
}

async function assertLiveIsolation(order: 'valid-first' | 'foreign-first') {
  const { validElement, foreignElement } = await renderLiveIsolationPair(order)
  expect(foreignElement.textContent).toContain('foreign:squads')
  const options = Array.from(validElement.querySelectorAll('select[aria-label="Default Squad"] option')).map(
    (option) => option.textContent
  )
  expect(options).toContain('Squad A')
  expect(options).toContain('Squad B')
}

describe('ChannelsSection API isolation', () => {
  test('isolates a live malformed foreign squads client when the valid tree renders first', async () => {
    await assertLiveIsolation('valid-first')
  })

  test('isolates a live malformed foreign squads client when the foreign tree renders first', async () => {
    await assertLiveIsolation('foreign-first')
  })

  test('keeps concurrent live overrides separate and leaves the real default intact', async () => {
    await assertLiveIsolation('valid-first')
    expect(
      renderToString(
        <QueryClientProvider client={new QueryClient()}>
          <SquadsContractProbe expectedDefault={listSquads} />
        </QueryClientProvider>
      )
    ).toContain('real-default')
  })
})

describe('AddChannelForm — provider-first flow', () => {
  test('shows only the provider picker until a provider is chosen', async () => {
    const { window } = await renderComponent(<AddChannelForm onClose={() => {}} onCreated={() => {}} />)
    expect(window.document.body.textContent).toContain('Discord')
    expect(window.document.body.textContent).toContain('Slack')
    expect(window.document.body.textContent).toContain('Telegram')
    // No "Name" field, no id input, no provider-specific field until a provider is picked.
    expect(window.document.querySelector('input[aria-label="Name"]')).toBeNull()
    expect(window.document.body.textContent).not.toContain('Discord server ID')
  })

  test('choosing Slack swaps in Slack-specific labels, not Discord/Telegram ones', async () => {
    const { window } = await renderComponent(<AddChannelForm onClose={() => {}} onCreated={() => {}} />)
    const slackRadio = window.document.querySelector('input[type="radio"][value="slack"]') as HTMLInputElement
    await click(window, slackRadio)

    expect(window.document.body.textContent).toContain('Slack workspace ID')
    expect(window.document.body.textContent).not.toContain('Discord server ID')
    expect(window.document.body.textContent).not.toContain('Telegram bot ID')
  })

  test('renders the intro copy explaining channels, squads, and overrides', async () => {
    const { window } = await renderComponent(<AddChannelForm onClose={() => {}} onCreated={() => {}} />)
    const text = window.document.body.textContent ?? ''
    expect(text).toContain('Discord, Slack, or Telegram')
    expect(text.toLowerCase()).toContain('default squad')
    expect(text.toLowerCase()).toContain('override')
  })

  test('never renders a free-text ID input for the operator to type into', async () => {
    const { window } = await renderComponent(<AddChannelForm onClose={() => {}} onCreated={() => {}} />)
    const discordRadio = window.document.querySelector('input[type="radio"][value="discord"]') as HTMLInputElement
    await click(window, discordRadio)

    // No input whose label mentions "ID" — the generated id is shown as static text only.
    const idInputs = Array.from(window.document.querySelectorAll('input')).filter((el) =>
      (el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').toLowerCase().includes('unique key')
    )
    expect(idInputs.length).toBe(0)
  })
})

describe('AddChannelForm — generated id', () => {
  test('auto-generates <provider>-<hash> and shows it as read-only text', async () => {
    const { window } = await renderComponent(<AddChannelForm onClose={() => {}} onCreated={() => {}} />)
    const discordRadio = window.document.querySelector('input[type="radio"][value="discord"]') as HTMLInputElement
    await click(window, discordRadio)

    expect(window.document.body.textContent).toMatch(/discord-[0-9a-f]{6}/)
  })
})

describe('AddChannelForm — squad overrides serialize to the exact backend map shape', () => {
  test('submits channelSquadMap as a plain channelId -> squadId map, using the generated id', async () => {
    const { window } = await renderComponent(<AddChannelForm onClose={() => {}} onCreated={() => {}} />)

    const discordRadio = window.document.querySelector('input[type="radio"][value="discord"]') as HTMLInputElement
    await click(window, discordRadio)

    const nameInput = window.document.querySelector('input[aria-label="Name"]') as HTMLInputElement
    await typeInput(window, nameInput, 'Acme Discord')

    const guildInput = window.document.querySelector('input[aria-label="Discord server ID"]') as HTMLInputElement
    await typeInput(window, guildInput, 'guild-123')

    const defaultSquadSelect = window.document.querySelector('select[aria-label="Default Squad"]') as HTMLSelectElement
    await selectOption(window, defaultSquadSelect, 'squad-a')

    const addOverrideButton = Array.from(window.document.querySelectorAll('button')).find(
      (b) => b.textContent === '+ Add override'
    ) as HTMLButtonElement
    await click(window, addOverrideButton)

    const overrideChannelInput = window.document.querySelector(
      'input[aria-label="Discord channel ID"]'
    ) as HTMLInputElement
    await typeInput(window, overrideChannelInput, 'chan-1')

    const overrideSquadSelect = window.document.querySelector(
      'select[aria-label="Squad override 1 target squad"]'
    ) as HTMLSelectElement
    await selectOption(window, overrideSquadSelect, 'squad-b')

    const createButton = Array.from(window.document.querySelectorAll('button')).find(
      (b) => b.textContent === 'Create'
    ) as HTMLButtonElement
    await click(window, createButton)

    expect(createChannelInstanceCalls.length).toBe(1)
    const payload = createChannelInstanceCalls[0] as {
      id: string
      name: string
      provider: string
      providerConfig: Record<string, unknown>
      channelSquadMap: Record<string, string>
      defaultSquadId: string | null
    }
    expect(payload.id).toMatch(/^discord-[0-9a-f]{6}$/)
    expect(payload.name).toBe('Acme Discord')
    expect(payload.provider).toBe('discord')
    expect(payload.providerConfig).toEqual({ guildId: 'guild-123' })
    expect(payload.defaultSquadId).toBe('squad-a')
    expect(payload.channelSquadMap).toEqual({ 'chan-1': 'squad-b' })
  })
})

describe('AddChannelForm — empty-override-row validation', () => {
  test('blocks create and does not call the API when an override row is only half-filled', async () => {
    const { window } = await renderComponent(<AddChannelForm onClose={() => {}} onCreated={() => {}} />)

    const discordRadio = window.document.querySelector('input[type="radio"][value="discord"]') as HTMLInputElement
    await click(window, discordRadio)

    const nameInput = window.document.querySelector('input[aria-label="Name"]') as HTMLInputElement
    await typeInput(window, nameInput, 'Acme Discord')

    const defaultSquadSelect = window.document.querySelector('select[aria-label="Default Squad"]') as HTMLSelectElement
    await selectOption(window, defaultSquadSelect, 'squad-a')

    const addOverrideButton = Array.from(window.document.querySelectorAll('button')).find(
      (b) => b.textContent === '+ Add override'
    ) as HTMLButtonElement
    await click(window, addOverrideButton)

    // Fill only the channel id, leave the squad unselected.
    const overrideChannelInput = window.document.querySelector(
      'input[aria-label="Discord channel ID"]'
    ) as HTMLInputElement
    await typeInput(window, overrideChannelInput, 'chan-1')

    const createButton = Array.from(window.document.querySelectorAll('button')).find(
      (b) => b.textContent === 'Create'
    ) as HTMLButtonElement
    await click(window, createButton)

    expect(createChannelInstanceCalls.length).toBe(0)
    expect(window.document.body.textContent).toMatch(/fill in both/i)
  })

  test('a fully blank added row does not block create and is dropped from the map', async () => {
    const { window } = await renderComponent(<AddChannelForm onClose={() => {}} onCreated={() => {}} />)

    const discordRadio = window.document.querySelector('input[type="radio"][value="discord"]') as HTMLInputElement
    await click(window, discordRadio)

    const nameInput = window.document.querySelector('input[aria-label="Name"]') as HTMLInputElement
    await typeInput(window, nameInput, 'Acme Discord')

    const defaultSquadSelect = window.document.querySelector('select[aria-label="Default Squad"]') as HTMLSelectElement
    await selectOption(window, defaultSquadSelect, 'squad-a')

    const addOverrideButton = Array.from(window.document.querySelectorAll('button')).find(
      (b) => b.textContent === '+ Add override'
    ) as HTMLButtonElement
    await click(window, addOverrideButton)

    const createButton = Array.from(window.document.querySelectorAll('button')).find(
      (b) => b.textContent === 'Create'
    ) as HTMLButtonElement
    await click(window, createButton)

    expect(createChannelInstanceCalls.length).toBe(1)
    const payload = createChannelInstanceCalls[0] as { channelSquadMap: Record<string, string> }
    expect(payload.channelSquadMap).toEqual({})
  })
})

function channel(overrides: Partial<ChannelInstanceConfig>): ChannelInstanceConfig {
  return {
    id: 'discord-abc123',
    name: 'Acme Discord',
    provider: 'discord',
    providerConfig: { guildId: 'guild-1' },
    channelSquadMap: {},
    defaultSquadId: 'squad-a',
    disabled: false,
    yamlFieldOverrides: [],
    hasTemplate: false,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  }
}

describe('ChannelRow edit form — round-trips an existing hand-written map', () => {
  test('loads each map entry into its own row, including one pointing at a squad that no longer exists', async () => {
    const ch = channel({ channelSquadMap: { 'chan-1': 'squad-a', 'chan-2': 'squad-ghost' } })
    const { window } = await renderComponent(
      <ChannelRow
        channel={ch}
        isExpanded={true}
        onToggle={() => {}}
        onShowDiff={() => {}}
        canUpdate={true}
        canDelete={true}
      />
    )

    const rowInputs = Array.from(window.document.querySelectorAll('input[aria-label="Discord channel ID"]')).map(
      (el) => (el as HTMLInputElement).value
    )
    expect(rowInputs.sort()).toEqual(['chan-1', 'chan-2'])

    // The row pointing at a deleted squad must say so honestly, not silently
    // swap in some other squad or vanish.
    expect(window.document.body.textContent).toMatch(/no longer exists/i)
    expect(window.document.body.textContent).toContain('squad-ghost')
  })

  test('saving after a round-trip resubmits the exact same map', async () => {
    const originalMap = { 'chan-1': 'squad-a', 'chan-2': 'squad-b' }
    const ch = channel({ channelSquadMap: originalMap })
    const { window } = await renderComponent(
      <ChannelRow
        channel={ch}
        isExpanded={true}
        onToggle={() => {}}
        onShowDiff={() => {}}
        canUpdate={true}
        canDelete={true}
      />
    )

    const saveButton = Array.from(window.document.querySelectorAll('button')).find(
      (b) => b.textContent === 'Save'
    ) as HTMLButtonElement
    await click(window, saveButton)

    expect(updateChannelInstanceCalls.length).toBe(1)
    const { data } = updateChannelInstanceCalls[0] as { data: { channelSquadMap: Record<string, string> } }
    expect(data.channelSquadMap).toEqual(originalMap)
  })
})

function button(window: typeof dom.window, text: string) {
  return Array.from(window.document.querySelectorAll('button')).find((el) => el.textContent === text)!
}

function defaultSelect(window: typeof dom.window) {
  return window.document.querySelector('select[aria-label="Default Squad"]') as HTMLSelectElement
}

function expectDefaultError(window: typeof dom.window) {
  const select = defaultSelect(window)
  expect(select.getAttribute('aria-invalid')).toBe('true')
  const descriptions = select
    .getAttribute('aria-describedby')!
    .split(' ')
    .map((id) => window.document.getElementById(id)?.textContent)
    .join(' ')
  expect(descriptions).toContain('Select a default squad')
}

describe('required default squad', () => {
  for (const provider of ['telegram', 'slack', 'discord'] as const) {
    test(`${provider}: create requires a default even with a complete override`, async () => {
      const { window } = await renderComponent(
        <AddChannelForm initialProvider={provider} onClose={() => {}} onCreated={() => {}} />
      )
      const select = defaultSelect(window)
      expect(select.required).toBe(true)
      expect(select.value).toBe('')
      expect(select.querySelector('option[value=""]')?.textContent).toContain('Select a squad')
      expect((select.querySelector('option[value=""]') as HTMLOptionElement).disabled).toBe(true)
      expect(window.document.body.textContent).toContain('Default Squad (required)')
      await typeInput(
        window,
        window.document.querySelector('input[aria-label="Name"]') as HTMLInputElement,
        'Test connection'
      )
      await click(window, button(window, 'Create'))
      expect(createChannelInstanceCalls).toHaveLength(0)
      expectDefaultError(window)
      await click(window, button(window, '+ Add override'))
      const overrideLabel = { telegram: 'Telegram chat ID', slack: 'Slack channel ID', discord: 'Discord channel ID' }[
        provider
      ]
      await typeInput(
        window,
        window.document.querySelector(`input[aria-label="${overrideLabel}"]`) as HTMLInputElement,
        'chat-1'
      )
      await selectOption(
        window,
        window.document.querySelector('select[aria-label="Squad override 1 target squad"]') as HTMLSelectElement,
        'squad-b'
      )
      await click(window, button(window, 'Create'))
      expect(createChannelInstanceCalls).toHaveLength(0)
      expectDefaultError(window)
      await selectOption(window, select, 'squad-a')
      expect(select.getAttribute('aria-invalid')).not.toBe('true')
      await click(window, button(window, 'Create'))
      expect(createChannelInstanceCalls).toEqual([
        expect.objectContaining({ defaultSquadId: 'squad-a', channelSquadMap: { 'chat-1': 'squad-b' } }),
      ])
    })
  }

  test('saving a legacy null default is blocked despite overrides, and choosing a squad repairs it', async () => {
    const { window } = await renderComponent(
      <ChannelRow
        channel={channel({ defaultSquadId: null, channelSquadMap: { 'chat-1': 'squad-b' } })}
        isExpanded
        onToggle={() => {}}
        onShowDiff={() => {}}
        canUpdate
        canDelete
      />
    )
    expect(defaultSelect(window).value).toBe('')
    await click(window, button(window, 'Save'))
    expect(updateChannelInstanceCalls).toHaveLength(0)
    expectDefaultError(window)
    await selectOption(window, defaultSelect(window), 'squad-a')
    await click(window, button(window, 'Save'))
    expect(updateChannelInstanceCalls).toEqual([
      {
        id: 'discord-abc123',
        data: expect.objectContaining({ defaultSquadId: 'squad-a', channelSquadMap: { 'chat-1': 'squad-b' } }),
      },
    ])
  })

  for (const isExpanded of [false, true]) {
    test(`legacy null default warning is visible when expanded=${isExpanded}, including read-only connections`, async () => {
      const { window } = await renderComponent(
        <ChannelRow
          channel={channel({ defaultSquadId: null })}
          isExpanded={isExpanded}
          onToggle={() => {}}
          onShowDiff={() => {}}
          canUpdate={false}
          canDelete={false}
        />
      )
      expect(window.document.body.textContent).toContain('Needs configuration')
      const disclosure = window.document.querySelector('button[aria-expanded]')
      expect(disclosure?.getAttribute('aria-expanded')).toBe(String(isExpanded))
      expect(disclosure?.textContent).toContain('Needs configuration')
      if (isExpanded) {
        expect(window.document.body.textContent).toContain(
          'New conversations without a matching override cannot be routed'
        )
        expect(window.document.body.textContent).toContain('Ask an administrator to select a Default Squad')
        expect((button(window, 'Save') as HTMLButtonElement).disabled).toBe(true)
      }
      expect(updateChannelInstanceCalls).toHaveLength(0)
    })
  }

  test('valid connections have no configuration warning', async () => {
    const { window } = await renderComponent(
      <ChannelRow
        channel={channel({})}
        isExpanded={false}
        onToggle={() => {}}
        onShowDiff={() => {}}
        canUpdate
        canDelete
      />
    )
    expect(window.document.body.textContent).not.toContain('Needs configuration')
  })
})

function ChannelListFixture() {
  const [ids, setIds] = useState(['first', 'second'])
  return (
    <>
      <ChannelIdsEditor kind="Allowed" value={ids} onChange={setIds}>
        All channels when empty.
      </ChannelIdsEditor>
      <output>{JSON.stringify(ids)}</output>
    </>
  )
}

describe('channel access list and linking controls', () => {
  test('adds, edits and removes individual channel IDs without losing other rows', async () => {
    const { window } = await renderComponent(<ChannelListFixture />)
    const button = (label: string) => window.document.querySelector(`[aria-label="${label}"]`)!
    await click(window, button('Remove allowed channel 1'))
    expect(window.document.querySelector('output')!.textContent).toBe('["second"]')
    const add = [...window.document.querySelectorAll('button')].find((el) =>
      el.textContent?.includes('Add allowed channel')
    )!
    await click(window, add)
    await typeInput(window, button('Allowed channel ID 2') as HTMLInputElement, 'third')
    expect(window.document.querySelector('output')!.textContent).toBe('["second","third"]')
    await click(window, button('Remove allowed channel 2'))
    await click(window, button('Remove allowed channel 1'))
    expect(window.document.querySelector('output')!.textContent).toBe('[]')
  })

  test('copies the complete linking command and reports a failed clipboard write accurately', async () => {
    const { window } = await renderComponent(<ChannelLinkCommand code="fixture-code" />)
    const clipboard = navigator.clipboard
    const descriptor = Object.getOwnPropertyDescriptor(clipboard, 'writeText')
    const writes: string[] = []
    let fail = false
    Object.defineProperty(clipboard, 'writeText', {
      configurable: true,
      value: async (text: string) => {
        if (fail) throw new Error('Permission denied')
        writes.push(text)
      },
    })
    try {
      const copy = window.document.querySelector('[aria-label="Copy account linking command"]')!
      await click(window, copy)
      expect(writes).toEqual(['/ficus link fixture-code'])
      expect(copy.textContent).toBe('Copied')
      fail = true
      await click(window, copy)
      expect(copy.textContent).toBe('Copy')
      expect(window.document.querySelector('[role="alert"]')!.textContent).toContain('Couldn’t copy')
    } finally {
      if (descriptor) Object.defineProperty(clipboard, 'writeText', descriptor)
      else delete (clipboard as any).writeText
    }
  })
})
