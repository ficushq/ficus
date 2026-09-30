import { describe, expect, it } from 'bun:test'
import type { ChatWindowState } from './chatWindowState'
import { readView, viewKey, writeView } from './savedView'

function memory() {
  const items = new Map<string, string>()
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    items,
  }
}

const KEY = viewKey(false)

describe('saved view', () => {
  it('brings back the camera, the open card and the chat windows, as they were', () => {
    const storage = memory()
    writeView(
      KEY,
      {
        camera: { x: 120.4, y: -33.6, zoom: 1.23456 },
        selection: { kind: 'plot', streamId: 'ws-1' },
        chats: [
          { key: 'agent:a1', target: { kind: 'agent', agentId: 'a1' }, x: 40, y: 60, w: 380, h: 520, z: 2 },
          {
            key: 'assistant:c1',
            target: { kind: 'assistant', conversationId: 'c1' },
            x: 500,
            y: 60,
            w: 400,
            h: 500,
            z: 3,
            snap: 'right',
          },
        ],
      },
      storage
    )
    const view = readView(KEY, storage)
    expect(view.camera).toEqual({ x: 120, y: -34, zoom: 1.235 })
    expect(view.selection).toEqual({ kind: 'plot', streamId: 'ws-1' })
    expect(view.chats.map((c) => [c.key, c.z, c.snap])).toEqual([
      ['agent:a1', 2, undefined],
      ['assistant:c1', 3, 'right'],
    ])
  })

  it("doesn't reopen someone's person card, or an Assistant chat that was never started", () => {
    const storage = memory()
    writeView(
      KEY,
      {
        camera: null,
        selection: { kind: 'person', userId: 'u1' },
        chats: [{ key: 'assistant:new', target: { kind: 'assistant', fresh: 't' }, x: 0, y: 0, w: 1, h: 1, z: 1 }],
      },
      storage
    )
    expect(readView(KEY, storage)).toEqual({ camera: null, selection: null, chats: [] })
    // Your latest Assistant conversation does come back.
    writeView(
      KEY,
      {
        camera: null,
        selection: null,
        chats: [{ key: 'assistant:latest', target: { kind: 'assistant' }, x: 0, y: 0, w: 1, h: 1, z: 1 }],
      },
      storage
    )
    expect(readView(KEY, storage).chats.map((c) => c.key)).toEqual(['assistant:latest'])
  })

  it('ignores anything it cannot read, and keeps one window per conversation', () => {
    const storage = memory()
    storage.setItem(KEY, 'not json')
    expect(readView(KEY, storage)).toEqual({ camera: null, selection: null, chats: [] })
    storage.setItem(
      KEY,
      JSON.stringify({
        camera: { x: 'a', y: 0, zoom: 1 },
        selection: { kind: 'plot' },
        chats: [
          { target: { kind: 'agent', agentId: 'a1' }, x: 1, y: 2, w: 3, h: 4, z: 1, snap: 'sideways' },
          { target: { kind: 'agent', agentId: 'a1' }, x: 9, y: 9, w: 9, h: 9, z: 2 },
          { target: { kind: 'robot' }, x: 1, y: 2, w: 3, h: 4 },
        ],
      })
    )
    const view = readView(KEY, storage)
    expect(view.camera).toBeNull()
    expect(view.selection).toBeNull()
    expect(view.chats).toEqual([
      { key: 'agent:a1', target: { kind: 'agent', agentId: 'a1' }, x: 1, y: 2, w: 3, h: 4, z: 1 },
    ])
  })

  it("reopens a squad's field log window", () => {
    const storage = memory()
    const log: ChatWindowState = {
      key: 'fieldLog:sq-1',
      target: { kind: 'fieldLog', squadId: 'sq-1' },
      x: 1,
      y: 2,
      w: 3,
      h: 4,
      z: 1,
    }
    writeView(KEY, { camera: null, selection: null, chats: [log] }, storage)
    expect(readView(KEY, storage).chats).toEqual([log])
  })

  it('keeps the demo farm apart from the real one', () => {
    expect(viewKey(true)).not.toBe(viewKey(false))
    expect(viewKey(false)).toStartWith('ficus-farm:')
  })
})
