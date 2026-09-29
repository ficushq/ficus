/**
 * Test harness for the farm's multiplayer UI (farm chat, the character
 * builder, the welcome): a Multiplayer value over the demo's in-memory chat,
 * with every action a bun mock, rendered with react-dom in happy-dom.
 * Test-only; not imported by the app.
 */
import { mock } from 'bun:test'
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { demoMultiplayer } from '../dev/demoMultiplayer'
import { SkinContext, SKINS, type SkinId } from '../skins'
import { MultiplayerContext, type Multiplayer } from './MultiplayerProvider'
import { defaultLookFor } from './personLook'

export async function fakeMultiplayer(overrides: Partial<Multiplayer> = {}): Promise<Multiplayer> {
  const demo = demoMultiplayer()
  return {
    enabled: true,
    setEnabled: mock(() => {}),
    me: demo.me,
    people: [],
    arrivals: new Set(),
    departures: [],
    bubbles: new Map(),
    emotes: new Map(),
    wave: mock(() => {}),
    emote: mock(() => {}),
    setFocus: mock(() => {}),
    focus: null,
    chat: demo.chat,
    rooms: await demo.chat.rooms(),
    unread: 0,
    typingIn: () => [],
    sendTyping: mock(() => {}),
    myLook: defaultLookFor(demo.me.userId),
    setMyLook: mock(() => {}),
    notify: 'off',
    setNotify: mock(async () => true),
    openRoom: null,
    setViewing: mock(() => {}),
    canChat: true,
    ...overrides,
  }
}

export async function renderWith(
  ui: ReactNode,
  multiplayer: Multiplayer,
  { skin = 'nostalgic', setSkin = mock(() => {}) }: { skin?: SkinId; setSkin?: (id: SkinId) => void } = {}
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <SkinContext.Provider value={{ skin: SKINS.find((s) => s.id === skin)!, setSkin }}>
          <MultiplayerContext.Provider value={multiplayer}>{ui}</MultiplayerContext.Provider>
        </SkinContext.Provider>
      </QueryClientProvider>
    )
    await Promise.resolve()
  })
  return {
    container,
    queryClient,
    unmount: () => {
      act(() => root.unmount())
      container.remove()
    },
  }
}
