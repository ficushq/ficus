import { expect, mock, test } from 'bun:test'
import { RealtimeTransport, PEER_CONNECTION_DISCONNECTED_GRACE_MS, summarizeRtcStats } from './realtimeTransport'
import { restoreVoiceConversation } from './voiceConversationRecovery'

test('failed ICE diagnostics report candidate availability without exposing network addresses', () => {
  const stats = new Map([
    ['local', { id: 'local', type: 'local-candidate', candidateType: 'srflx', address: '192.0.2.1' }],
    ['remote', { id: 'remote', type: 'remote-candidate', candidateType: 'host', address: '192.0.2.2' }],
    ['pair', { id: 'pair', type: 'candidate-pair', state: 'failed' }],
  ])
  const summary = summarizeRtcStats(stats as unknown as RTCStatsReport)
  expect(summary.localCandidateTypes).toEqual({ srflx: 1 })
  expect(summary.remoteCandidateTypes).toEqual({ host: 1 })
  expect(summary.candidatePairStates).toEqual({ failed: 1 })
  expect(JSON.stringify(summary)).not.toContain('192.0.2.')
})

function setup() {
  let callback: (() => void) | undefined
  const clock = {
    setTimeout: mock((fn: () => void, _ms: number) => {
      callback = fn
      return 1 as any
    }),
    clearTimeout: mock(() => {
      callback = undefined
    }),
  }
  const transport = new RealtimeTransport(clock as any)
  // Isolate the peer-state boundary without creating media tracks or a real browser connection.
  const internal = transport as any
  internal.hasOpenedDataChannel = true
  internal.peerConnection = { connectionState: 'disconnected' }
  internal.localTrack = { enabled: true }
  internal.handleFailure = mock()
  return { transport, internal, clock, expire: () => callback?.() }
}

test('temporary peer disconnection survives the old three-second cutoff and clears on recovery', () => {
  const { internal, clock, expire } = setup()
  internal.handlePeerConnectionStateChange('disconnected')
  expect(clock.setTimeout.mock.calls[0][1]).toBe(PEER_CONNECTION_DISCONNECTED_GRACE_MS)
  expect(PEER_CONNECTION_DISCONNECTED_GRACE_MS).toBeGreaterThan(3000)
  internal.peerConnection.connectionState = 'connected'
  internal.handlePeerConnectionStateChange('connected')
  expire()
  expect(internal.handleFailure).not.toHaveBeenCalled()
})

test('a sustained disconnected peer is detected even if the microphone is muted', () => {
  const { transport, internal, clock, expire } = setup()
  internal.handlePeerConnectionStateChange('disconnected')
  transport.setMicEnabled(false)
  expect(clock.setTimeout).toHaveBeenCalledTimes(1)
  expire()
  expect(internal.handleFailure).toHaveBeenCalledWith(
    `Peer connection disconnected for ${PEER_CONNECTION_DISCONNECTED_GRACE_MS}ms`
  )
})

test('recovery restores completed spoken turns without replaying tools, unfinished speech, or response requests', () => {
  const sendEvent = mock()
  restoreVoiceConversation({ sendEvent }, [
    { role: 'user', text: 'What is Ficus doing?', final: true },
    { role: 'tool', text: 'get_status', final: true, toolArgs: '{"id":"tau"}' },
    { role: 'assistant', text: 'The squad is idle.', final: true },
    { role: 'assistant', text: 'unfinished', final: false },
    { role: 'assistant', text: 'interrupted', final: true, interrupted: true },
  ])
  expect(sendEvent.mock.calls.map(([event]) => [event.type, event.item.role, event.item.content[0]])).toEqual([
    ['conversation.item.create', 'user', { type: 'input_text', text: 'What is Ficus doing?' }],
    ['conversation.item.create', 'assistant', { type: 'output_text', text: 'The squad is idle.' }],
  ])
})

test('disabling voice detaches and stops audio without generating a replacement stream', async () => {
  const transport = new RealtimeTransport()
  const internal = transport as any
  const stop = mock()
  const replaceTrack = mock(async () => {})
  internal.audioSender = { replaceTrack }
  internal.localTrack = { stop }
  await transport.disableAudioInput()
  expect(stop).toHaveBeenCalledTimes(1)
  expect(replaceTrack.mock.calls).toEqual([[null]])
  expect(internal.localTrack).toBeNull()
})

test('default disconnect timers preserve the browser global receiver during disconnection and recovery', () => {
  const originalSet = globalThis.setTimeout
  const originalClear = globalThis.clearTimeout
  let scheduled: (() => void) | undefined
  const receivers: unknown[] = []
  globalThis.setTimeout = function (this: unknown, handler: () => void) {
    receivers.push(this)
    if (this !== globalThis) throw new TypeError('setTimeout requires Window receiver')
    scheduled = handler
    return 1 as any
  } as typeof setTimeout
  globalThis.clearTimeout = function (this: unknown) {
    receivers.push(this)
    if (this !== globalThis) throw new TypeError('clearTimeout requires Window receiver')
    scheduled = undefined
  } as typeof clearTimeout
  try {
    const internal = new RealtimeTransport() as any
    internal.hasOpenedDataChannel = true
    internal.peerConnection = { connectionState: 'disconnected' }
    internal.handleFailure = mock()
    internal.handlePeerConnectionStateChange('disconnected')
    expect(scheduled).toBeDefined()
    internal.peerConnection.connectionState = 'connected'
    internal.handlePeerConnectionStateChange('connected')
    expect(scheduled).toBeUndefined()
    internal.peerConnection.connectionState = 'disconnected'
    internal.handlePeerConnectionStateChange('disconnected')
    scheduled!()
    expect(internal.handleFailure).toHaveBeenCalledTimes(1)
    expect(receivers).toEqual([globalThis, globalThis, globalThis])
  } finally {
    globalThis.setTimeout = originalSet
    globalThis.clearTimeout = originalClear
  }
})

test('history restoration skips entries whose IDs are still queued as pending model input', () => {
  const sendEvent = mock(() => {})
  restoreVoiceConversation(
    { sendEvent },
    [
      { id: 'user-1', role: 'user', text: 'Compare hosting options', final: true },
      {
        id: 'inbox:update-1',
        role: 'tool',
        text: 'Task update',
        final: true,
        toolName: 'assistant_inbox',
        toolResult: '{"updates":[{"content":"Comparison ready"}]}',
      },
      { id: 'assistant-1', role: 'assistant', text: 'Working on it.', final: true },
    ],
    new Set(['inbox:update-1'])
  )
  const texts = sendEvent.mock.calls.map(([event]: any[]) => event.item.content[0].text)
  expect(texts).toEqual(['Compare hosting options', 'Working on it.'])
})
