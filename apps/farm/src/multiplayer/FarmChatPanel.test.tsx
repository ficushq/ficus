import { afterEach, describe, expect, it, mock } from 'bun:test'
import type { Agent } from '@ficus/shared'
import { byText, click, keyDown, typeInto, waitFor } from '../chat/testing'
import { sampleFarm } from '../dev/sampleFarm'
import { FarmCardContext, type FarmCardEnv } from '../farm/cards/context'
import { layoutFarm } from '../farm/layout'
import { FarmChatPanel } from './FarmChatPanel'
import { MessageBody } from './MessageBody'
import { Markdown } from '../chat/Markdown'
import { fakeMultiplayer, renderWith } from './testing'

const mounted: Array<() => void> = []
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount()
  localStorage.clear()
})

async function openGeneral() {
  const multiplayer = await fakeMultiplayer()
  const view = await renderWith(
    <FarmChatPanel roomId={null} onRoom={() => {}} onClose={() => {}} narrow={false} />,
    multiplayer
  )
  mounted.push(view.unmount)
  await waitFor(() => expect(view.container.textContent).toContain('Welcome to the farm, everyone.'))
  const composer = view.container.querySelector<HTMLTextAreaElement>('.g-farmchat-composer textarea')!
  return { ...view, multiplayer, composer }
}

async function send(composer: HTMLTextAreaElement, text: string) {
  typeInto(composer, text)
  await keyDown(composer, { key: 'Enter' })
}

describe('FarmChatPanel', () => {
  it('lists the rooms, opens # general, and sends a message', async () => {
    const { container, composer } = await openGeneral()
    expect(byText(container, '.g-farmchat-room', /general/)).toBeDefined()
    expect(byText(container, '.g-farmchat-room', /Rosa Díaz/)).toBeDefined()
    await send(composer, 'Morning, farm')
    await waitFor(() => expect(byText(container, '.g-farmchat-mine .g-farmchat-text', /Morning, farm/)).toBeDefined())
    expect(composer.value).toBe('')
  })

  it('reacts to a message (floating the emoji over you) and edits your own', async () => {
    const { container, composer, multiplayer } = await openGeneral()
    await send(composer, 'First draft')
    await waitFor(() => expect(container.querySelector('.g-farmchat-mine')).not.toBeNull())
    const mine = container.querySelector('.g-farmchat-mine')!

    await click(mine.querySelector('button[aria-label="React"]'))
    await click(mine.querySelector('button[aria-label="React 🌱"]'))
    await waitFor(() => expect(mine.querySelector('.g-farmchat-reaction-mine')?.textContent).toContain('🌱'))
    expect(multiplayer.emote).toHaveBeenCalledWith('🌱')

    await click(mine.querySelector('button[aria-label="Edit"]'))
    const editor = mine.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit your message"]')!
    typeInto(editor, 'Final draft')
    await keyDown(editor, { key: 'Enter' })
    await waitFor(() => expect(mine.textContent).toContain('Final draft (edited)'))
  })

  it('suggests people after "@", and inserts the one you pick', async () => {
    const { container, composer } = await openGeneral()
    // As typed: focused, with the caret after what's been typed (which happy-dom doesn't move by itself).
    composer.focus()
    typeInto(composer, 'hey @ro')
    composer.setSelectionRange(7, 7)
    await keyDown(composer, { key: 'o' })
    await waitFor(() => expect(container.querySelector('.g-farmchat-suggest')?.textContent).toContain('Rosa Díaz'))
    await keyDown(composer, { key: 'Enter' })
    expect(composer.value).toBe('hey @Rosa Díaz ')
    expect(container.querySelector('.g-farmchat-suggest')).toBeNull()
  })

  it('deletes your own message after a confirming second click', async () => {
    const { container, composer } = await openGeneral()
    await send(composer, 'Oops, wrong room')
    await waitFor(() => expect(container.querySelector('.g-farmchat-mine')).not.toBeNull())
    const mine = container.querySelector('.g-farmchat-mine')!
    await click(mine.querySelector('button[aria-label="Delete"]'))
    expect(container.textContent).toContain('Oops, wrong room')
    await click(mine.querySelector('button[aria-label^="Really delete"]'))
    await waitFor(() => expect(container.textContent).not.toContain('Oops, wrong room'))
  })

  it('is read-only without farm:chat: no composer, reactions, edits or new DMs', async () => {
    const multiplayer = await fakeMultiplayer({ canChat: false })
    multiplayer.rooms = { ...multiplayer.rooms!, canChat: false, canManageRooms: false }
    const view = await renderWith(
      <FarmChatPanel roomId={null} onRoom={() => {}} onClose={() => {}} narrow={false} />,
      multiplayer
    )
    mounted.push(view.unmount)
    await waitFor(() => expect(view.container.textContent).toContain('Welcome to the farm, everyone.'))
    expect(view.container.querySelector<HTMLFormElement>('.g-farmchat-composer')!.hidden).toBe(true)
    expect(view.container.textContent).toContain('You can read farm chat, but not post here')
    expect(view.container.querySelector('button[aria-label="React"]')).toBeNull()
    expect(view.container.querySelector('button[aria-label="Delete"]')).toBeNull()
    expect(view.container.textContent).not.toContain('+ New message')
  })

  it('turns notifications on from the bell', async () => {
    const { container, multiplayer } = await openGeneral()
    await click(container.querySelector('.g-farmchat-bell'))
    expect(multiplayer.setNotify).toHaveBeenCalledWith(true)
  })
})

describe('MessageBody', () => {
  it('draws farm references as chips that fly there, and mentions of you', async () => {
    const input = sampleFarm()
    const flyTo = mock(() => {})
    const env = {
      layout: layoutFarm(input),
      input,
      agentsById: new Map<string, Agent>(input.agents.map((a) => [a.id, a])),
      squadsById: new Map(input.squads.map((s) => [s.id, s])),
      flyTo,
    } as unknown as FarmCardEnv
    const view = await renderWith(
      <FarmCardContext.Provider value={env}>
        <p>
          <MessageBody
            body="@You look at ficus:ws:2, not ficus:ws:999"
            people={[{ id: 'demo-you', name: 'You' }]}
            meId="demo-you"
          />
        </p>
      </FarmCardContext.Provider>,
      await fakeMultiplayer()
    )
    mounted.push(view.unmount)
    expect(view.container.querySelector('.g-farmchat-mention-me')?.textContent).toBe('@You')
    const chip = byText(view.container, 'button.g-farmchat-chip', /Retry flaky webhook deliveries/)
    await click(chip)
    expect(flyTo).toHaveBeenCalledWith({ kind: 'plot', streamId: 'ws-2' })
    expect(byText(view.container, 'span.g-farmchat-chip', /Work stream 999/)).toBeDefined()
  })

  it('turns work stream links in markdown (agents write them in questions and chat) into chips', async () => {
    const input = sampleFarm()
    const flyTo = mock(() => {})
    const env = {
      layout: layoutFarm(input),
      input,
      agentsById: new Map<string, Agent>(input.agents.map((a) => [a.id, a])),
      squadsById: new Map(input.squads.map((s) => [s.id, s])),
      flyTo,
    } as unknown as FarmCardEnv
    const view = await renderWith(
      <FarmCardContext.Provider value={env}>
        <Markdown>{'See [#2](tau:ws:2) and [the docs](https://example.com).'}</Markdown>
      </FarmCardContext.Provider>,
      await fakeMultiplayer()
    )
    mounted.push(view.unmount)
    await click(byText(view.container, 'button.g-farmchat-chip', /Retry flaky webhook deliveries/))
    expect(flyTo).toHaveBeenCalledWith({ kind: 'plot', streamId: 'ws-2' })
    expect(view.container.querySelector('a[href="https://example.com"]')).not.toBeNull()
  })
})
