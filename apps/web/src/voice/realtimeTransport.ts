import { authFetch } from '../api/client'

// --- Types ---

export interface RealtimeSessionConfig {
  model: string
  instructions: string
  tools: RealtimeFunctionTool[]
  output_modalities: string[]
  tool_choice: string
  reasoning?: {
    effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  }
  truncation?:
    | 'disabled'
    | {
        type: 'retention_ratio'
        retention_ratio: number
        token_limits?: {
          post_instructions?: number
        }
      }
  audio: {
    input: {
      transcription?: {
        model?: string
        language?: string
      }
      noise_reduction?: { type?: string } | null
      turn_detection:
        | {
            type: 'server_vad'
            threshold?: number
            prefix_padding_ms?: number
            silence_duration_ms?: number
            create_response?: boolean
            interrupt_response?: boolean
          }
        | {
            type: 'semantic_vad'
            eagerness?: 'low' | 'medium' | 'high' | 'auto'
            create_response?: boolean
            interrupt_response?: boolean
          }
        | null
    }
    output?: {
      voice?: string
    }
  }
}

export interface RealtimeFunctionTool {
  type: 'function'
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface RealtimeServerEvent {
  type: string
  [key: string]: unknown
}

export interface RealtimeClientEvent {
  type: string
  [key: string]: unknown
}

export interface TransportCallbacks {
  onServerEvent: (event: RealtimeServerEvent) => void
  onError: (error: Error) => void
  onInputLevel?: (level: number) => void
}

export interface RealtimeTransportConnectOptions {
  initialMicEnabled?: boolean
  textOnly?: boolean
}

const DATA_CHANNEL_OPEN_TIMEOUT_MS = 20_000
export const PEER_CONNECTION_DISCONNECTED_GRACE_MS = 15_000
const CONNECTION_STATS_SAMPLE_MS = 10_000
// These public modules are not content-hashed by Vite. Version both URLs so
// existing browsers do not reuse the previously broken CommonJS module.
const DTLN_WORKLET_PATH = 'voice/dtln/processor.js?v=3'
const DTLN_PROCESSOR_NAME = 'ficus-dtln-denoiser'

export function resolveDtlnWorkletUrl(baseUrl = import.meta.env.BASE_URL): string {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  return `${normalizedBase}${DTLN_WORKLET_PATH}`
}

export function createVoiceMicConstraints(): MediaStreamConstraints {
  return {
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: false,
      sampleRate: 16000,
    },
  }
}

export function applyDtlnNoiseReductionToSessionConfig(config: RealtimeSessionConfig): RealtimeSessionConfig {
  return {
    ...config,
    audio: {
      ...config.audio,
      input: {
        ...config.audio.input,
        noise_reduction: null,
      },
    },
  }
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext
  }
}

export function calculateInputLevel(samples: Uint8Array): number {
  if (samples.length === 0) return 0
  let sumSquares = 0
  for (const sample of samples) {
    const centered = (sample - 128) / 128
    sumSquares += centered * centered
  }
  const rms = Math.sqrt(sumSquares / samples.length)
  return Math.max(0, Math.min(rms * 2.8, 1))
}

export function summarizeRtcStats(stats: RTCStatsReport): Record<string, unknown> {
  let selectedCandidatePairId: string | undefined
  const candidates = new Map<string, RTCStats>()
  const summary: Record<string, unknown> = {}
  const localCandidateTypes: Record<string, number> = {}
  const remoteCandidateTypes: Record<string, number> = {}
  const candidatePairStates: Record<string, number> = {}

  stats.forEach((report) => {
    if (report.type === 'candidate-pair') {
      const candidatePair = report as RTCIceCandidatePairStats & { selected?: boolean; nominated?: boolean }
      candidatePairStates[candidatePair.state] = (candidatePairStates[candidatePair.state] ?? 0) + 1
      if (candidatePair.selected || candidatePair.nominated || candidatePair.state === 'succeeded') {
        selectedCandidatePairId = candidatePair.id
      }
    }
    if (report.type === 'local-candidate' || report.type === 'remote-candidate') {
      candidates.set(report.id, report)
      const counts = report.type === 'local-candidate' ? localCandidateTypes : remoteCandidateTypes
      const type = readStatsString(report, 'candidateType') ?? 'unknown'
      counts[type] = (counts[type] ?? 0) + 1
    }
  })
  Object.assign(summary, { localCandidateTypes, remoteCandidateTypes, candidatePairStates })

  const selectedPair = selectedCandidatePairId
    ? (stats.get(selectedCandidatePairId) as RTCIceCandidatePairStats | undefined)
    : undefined
  if (selectedPair) {
    const local = selectedPair.localCandidateId ? candidates.get(selectedPair.localCandidateId) : undefined
    const remote = selectedPair.remoteCandidateId ? candidates.get(selectedPair.remoteCandidateId) : undefined
    Object.assign(summary, {
      candidatePairState: selectedPair.state,
      localCandidateType: readStatsString(local, 'candidateType'),
      localProtocol: readStatsString(local, 'protocol'),
      remoteCandidateType: readStatsString(remote, 'candidateType'),
      remoteProtocol: readStatsString(remote, 'protocol'),
      currentRoundTripTime: selectedPair.currentRoundTripTime,
      availableOutgoingBitrate: selectedPair.availableOutgoingBitrate,
      bytesSent: selectedPair.bytesSent,
      bytesReceived: selectedPair.bytesReceived,
      packetsSent: selectedPair.packetsSent,
      packetsReceived: selectedPair.packetsReceived,
      requestsReceived: selectedPair.requestsReceived,
      responsesReceived: selectedPair.responsesReceived,
      consentRequestsSent: selectedPair.consentRequestsSent,
    })
  }

  let outboundAudio: RTCOutboundRtpStreamStats | undefined
  let inboundAudio: RTCInboundRtpStreamStats | undefined
  stats.forEach((report) => {
    if (report.type === 'outbound-rtp' && readStatsString(report, 'kind') === 'audio') {
      outboundAudio = report as RTCOutboundRtpStreamStats
    }
    if (report.type === 'inbound-rtp' && readStatsString(report, 'kind') === 'audio') {
      inboundAudio = report as RTCInboundRtpStreamStats
    }
  })

  if (outboundAudio) {
    summary.outboundAudioBytesSent = outboundAudio.bytesSent
    summary.outboundAudioPacketsSent = outboundAudio.packetsSent
  }
  if (inboundAudio) {
    summary.inboundAudioBytesReceived = inboundAudio.bytesReceived
    summary.inboundAudioPacketsReceived = inboundAudio.packetsReceived
    summary.inboundAudioPacketsLost = inboundAudio.packetsLost
    summary.inboundAudioJitter = inboundAudio.jitter
  }

  return summary
}

function readStatsString(report: RTCStats | undefined, key: string): string | undefined {
  if (!report) return undefined
  const value = (report as unknown as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : undefined
}

// --- Transport ---

export function applyInitialMicEnabledToTrack(track: Pick<MediaStreamTrack, 'enabled'>, enabled: boolean): void {
  track.enabled = enabled
}

export class RealtimeTransport {
  // Firefox requires native timer functions to keep their Window receiver.
  constructor(
    private readonly disconnectClock = {
      setTimeout: setTimeout.bind(globalThis),
      clearTimeout: clearTimeout.bind(globalThis),
    }
  ) {}

  private peerConnection: RTCPeerConnection | null = null
  private dataChannel: RTCDataChannel | null = null
  private audioSender: RTCRtpSender | null = null
  private audioGeneration = 0
  private inputLevelCallback: TransportCallbacks['onInputLevel']
  private localTrack: MediaStreamTrack | null = null
  private rawInputStream: MediaStream | null = null
  private audioElement: HTMLAudioElement | null = null
  private audioContext: AudioContext | null = null
  private denoiserAudioContext: AudioContext | null = null
  private denoiserOutputTrack: MediaStreamTrack | null = null
  private inputLevelFrame: number | null = null
  private onServerEvent: ((event: RealtimeServerEvent) => void) | null = null
  private onError: ((error: Error) => void) | null = null
  private hasOpenedDataChannel = false
  private isDisconnecting = false
  private connectedAtMs = 0
  private peerDisconnectedTimeout: ReturnType<typeof setTimeout> | null = null
  private pendingSessionUpdate: Partial<RealtimeSessionConfig> | null = null
  private micDisabledSinceMs: number | null = null
  private statsInterval: ReturnType<typeof setInterval> | null = null
  private lastConnectionStats: Record<string, unknown> | null = null

  async connect(
    session: RealtimeSessionConfig,
    callbacks: TransportCallbacks,
    signal?: AbortSignal,
    options: RealtimeTransportConnectOptions = {}
  ): Promise<void> {
    this.disconnect()
    this.onServerEvent = callbacks.onServerEvent
    this.onError = callbacks.onError

    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

    // 1. Create peer connection + data channel
    // Typed chat must establish ICE without getUserMedia permission. STUN provides
    // a public candidate when the browser withholds local interface addresses.
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] })
    this.peerConnection = pc

    this.audioElement = document.createElement('audio')
    this.audioElement.autoplay = true

    pc.ontrack = (event) => {
      if (this.audioElement) {
        this.audioElement.srcObject = event.streams[0] ?? null
      }
    }

    const dc = pc.createDataChannel('oai-events')
    this.dataChannel = dc

    dc.addEventListener('message', (event) => {
      if (this.dataChannel !== dc) return
      try {
        const payload = JSON.parse(String(event.data)) as RealtimeServerEvent
        this.onServerEvent?.(payload)
      } catch (error) {
        this.onError?.(error instanceof Error ? error : new Error('Invalid Realtime event'))
      }
    })

    dc.addEventListener('error', (event) => {
      if (this.dataChannel !== dc) return
      console.error('[voice] data channel error:', JSON.stringify(this.describeConnection()), event)
      if (this.hasOpenedDataChannel) this.handleFailure('Data channel error')
    })
    dc.addEventListener('close', () => {
      if (this.dataChannel !== dc) return
      const details = this.describeConnection()
      if (this.isDisconnecting) {
        console.info('[voice] data channel closed during disconnect:', JSON.stringify(details))
        return
      }
      console.warn('[voice] data channel closed:', JSON.stringify(details))
      if (this.hasOpenedDataChannel) this.handleFailure('Data channel closed')
    })

    pc.addEventListener('connectionstatechange', () => {
      if (this.peerConnection !== pc) return
      if (pc.connectionState === 'failed') void this.sampleConnectionStats('connection-failed')
      this.handlePeerConnectionStateChange(pc.connectionState)
    })
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') void this.sampleConnectionStats('gathering-complete')
    })

    // Negotiate an audio sender without opening the microphone for typed chat.
    this.audioSender = pc.addTransceiver('audio', { direction: 'sendrecv' }).sender
    this.inputLevelCallback = callbacks.onInputLevel
    if (!options.textOnly) await this.enableAudioInput(options.initialMicEnabled ?? true, signal)
    const realtimeSession = this.denoiserOutputTrack ? applyDtlnNoiseReductionToSessionConfig(session) : session

    // 3. Create SDP offer
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    const sdp = pc.localDescription?.sdp
    if (!sdp) throw new Error('Failed to generate SDP offer')

    // 4. Send to our proxy endpoint
    const formData = new FormData()
    formData.set('sdp', sdp)
    formData.set('session', JSON.stringify(realtimeSession))

    const response = await authFetch('/voice-session', {
      method: 'POST',
      body: formData,
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(20_000)]),
    })

    if (!response.ok) {
      const detail = await response.text()
      this.disconnect()
      throw new Error(`Voice session failed: ${detail}`)
    }

    const answerSdp = await response.text()
    if (!answerSdp.trim()) {
      this.disconnect()
      throw new Error('Empty SDP answer from server')
    }

    // 5. Complete WebRTC handshake
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp })

    // 6. Wait for data channel to open. Start this timeout only after the
    // remote description is set so slow mic/API setup time does not count as
    // data-channel-open time.
    await this.waitForDataChannelOpen(dc, pc, signal)

    this.hasOpenedDataChannel = true
    this.connectedAtMs = Date.now()
    this.startStatsSampler()

    // 7. Update session with full config, folding in any display/context
    // updates that React attempted while the data channel was still opening.
    const pendingSessionUpdate = this.pendingSessionUpdate
    this.pendingSessionUpdate = null
    this.updateSession({ ...realtimeSession, ...(pendingSessionUpdate ?? {}) })
  }

  async enableAudioInput(enabled: boolean, signal?: AbortSignal): Promise<void> {
    if (this.localTrack) {
      this.setMicEnabled(enabled)
      return
    }
    const pc = this.peerConnection
    const sender = this.audioSender
    if (!pc || !sender) throw new Error('Realtime is not connected')
    const generation = ++this.audioGeneration
    const stream = await navigator.mediaDevices.getUserMedia(createVoiceMicConstraints())
    let denoised: Awaited<ReturnType<RealtimeTransport['createDtlnDenoisedStream']>> = null
    const current = () => !signal?.aborted && this.peerConnection === pc && this.audioGeneration === generation
    try {
      if (!current()) throw new DOMException('Aborted', 'AbortError')
      denoised = await this.createDtlnDenoisedStream(stream)
      if (!denoised) {
        await Promise.all(
          stream.getAudioTracks().map((track) =>
            track.applyConstraints({ noiseSuppression: true }).catch((error) => {
              console.warn('[voice] browser noise suppression unavailable:', error)
            })
          )
        )
      }
      if (!current()) throw new DOMException('Aborted', 'AbortError')
      const outbound = denoised?.stream ?? stream
      const track = outbound.getAudioTracks()[0]
      if (!track) throw new Error('No microphone audio track is available')
      applyInitialMicEnabledToTrack(track, enabled)
      await sender.replaceTrack(track)
      if (!current()) throw new DOMException('Aborted', 'AbortError')
      this.rawInputStream = stream
      this.localTrack = track
      this.denoiserAudioContext = denoised?.context ?? null
      this.denoiserOutputTrack = denoised?.track ?? null
      this.startInputLevelMeter(outbound, this.inputLevelCallback)
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop())
      denoised?.track?.stop()
      await denoised?.context.close().catch(() => undefined)
      throw error
    }
  }

  async disableAudioInput(): Promise<void> {
    ++this.audioGeneration
    const sender = this.audioSender
    const context = this.denoiserAudioContext
    this.stopInputLevelMeter()
    this.localTrack?.stop()
    this.rawInputStream?.getTracks().forEach((track) => track.stop())
    this.denoiserOutputTrack?.stop()
    this.localTrack = null
    this.rawInputStream = null
    this.denoiserOutputTrack = null
    this.denoiserAudioContext = null
    await Promise.all([sender?.replaceTrack(null), context?.close().catch(() => undefined)])
  }

  disconnect(): void {
    ++this.audioGeneration
    if (this.isDisconnecting) return
    this.isDisconnecting = true

    this.clearPeerDisconnectedTimer()
    this.stopStatsSampler()
    this.stopInputLevelMeter()
    this.localTrack?.stop()
    this.rawInputStream?.getTracks().forEach((track) => track.stop())
    this.denoiserOutputTrack?.stop()
    void this.denoiserAudioContext?.close().catch(() => undefined)
    if (this.dataChannel?.readyState !== 'closed') this.dataChannel?.close()
    if (this.peerConnection?.connectionState !== 'closed') this.peerConnection?.close()
    this.audioElement?.remove()

    this.peerConnection = null
    this.dataChannel = null
    this.audioSender = null
    this.localTrack = null
    this.rawInputStream = null
    this.denoiserOutputTrack = null
    this.denoiserAudioContext = null
    this.audioElement = null
    this.onServerEvent = null
    this.onError = null
    this.hasOpenedDataChannel = false
    this.connectedAtMs = 0
    this.pendingSessionUpdate = null
    this.micDisabledSinceMs = null
    this.lastConnectionStats = null
    setTimeout(() => {
      this.isDisconnecting = false
    }, 0)
  }

  sendEvent(event: RealtimeClientEvent): void {
    if (this.dataChannel?.readyState === 'open') {
      this.dataChannel.send(JSON.stringify(event))
      return
    }

    console.warn('[voice] dropped realtime event because data channel is not open:', {
      readyState: this.dataChannel?.readyState,
      eventType: event.type,
    })
  }

  updateSession(config: Partial<RealtimeSessionConfig>): void {
    if (this.dataChannel?.readyState !== 'open') {
      this.pendingSessionUpdate = { ...(this.pendingSessionUpdate ?? {}), ...config }
      return
    }
    this.sendEvent({
      type: 'session.update',
      session: { type: 'realtime', ...config },
    })
  }

  sendFunctionResult(callId: string, output: unknown): void {
    this.sendEvent({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: JSON.stringify(output),
      },
    })
  }

  requestResponse(modality?: 'text' | 'audio'): void {
    this.sendEvent({ type: 'response.create', ...(modality ? { response: { output_modalities: [modality] } } : {}) })
  }

  clearInputAudioBuffer(): void {
    this.sendEvent({ type: 'input_audio_buffer.clear' })
  }

  submitInputAudioBuffer(): void {
    this.sendEvent({ type: 'input_audio_buffer.commit' })
    this.requestResponse()
  }

  cancelResponse(): void {
    this.sendEvent({ type: 'response.cancel' })
  }

  stopOutputPlayback(): void {
    if (!this.audioElement) return
    this.audioElement.muted = true
    this.audioElement.pause()
  }

  resumeOutputPlayback(): void {
    if (!this.audioElement) return
    this.audioElement.muted = false
    void this.audioElement.play().catch(() => {
      // The element may already be playing, or playback may wait for the next audio frame.
    })
  }

  setMicEnabled(enabled: boolean): void {
    if (this.localTrack) this.localTrack.enabled = enabled
    this.micDisabledSinceMs = enabled ? null : (this.micDisabledSinceMs ?? Date.now())
    if (this.peerConnection?.connectionState === 'disconnected') {
      this.schedulePeerDisconnectedTimer()
    }
  }

  get isConnected(): boolean {
    return this.hasOpenedDataChannel && this.dataChannel?.readyState === 'open'
  }

  private async createDtlnDenoisedStream(
    inputStream: MediaStream
  ): Promise<{ stream: MediaStream; context: AudioContext; track: MediaStreamTrack | null } | null> {
    if (typeof window === 'undefined') return null
    const AudioContextCtor = window.AudioContext ?? window.webkitAudioContext
    if (!AudioContextCtor || typeof AudioWorkletNode === 'undefined') return null

    let audioContext: AudioContext | null = null
    try {
      audioContext = new AudioContextCtor({ sampleRate: 16000 })
      await audioContext.audioWorklet.addModule(resolveDtlnWorkletUrl())

      const source = audioContext.createMediaStreamSource(inputStream)
      const denoiser = new AudioWorkletNode(audioContext, DTLN_PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { disableMetrics: true },
      })
      const destination = audioContext.createMediaStreamDestination()

      denoiser.port.onmessage = (event) => {
        if (event.data === 'ready') return
        if (event.data && typeof event.data === 'object' && 'type' in event.data && event.data.type === 'error') {
          console.warn('[voice] DTLN denoiser error:', event.data)
        }
      }

      source.connect(denoiser)
      denoiser.connect(destination)

      const [track] = destination.stream.getAudioTracks()
      console.info('[voice] DTLN noise reduction enabled')
      return { stream: destination.stream, context: audioContext, track: track ?? null }
    } catch (error) {
      await audioContext?.close().catch(() => undefined)
      console.warn('[voice] DTLN noise reduction unavailable; falling back to browser noise suppression:', error)
      return null
    }
  }

  private startInputLevelMeter(stream: MediaStream, onInputLevel?: (level: number) => void): void {
    if (!onInputLevel || typeof window === 'undefined') return
    const AudioContextCtor = window.AudioContext ?? window.webkitAudioContext
    if (!AudioContextCtor) return

    try {
      const audioContext = new AudioContextCtor()
      const analyser = audioContext.createAnalyser()
      analyser.fftSize = 1024
      const source = audioContext.createMediaStreamSource(stream)
      source.connect(analyser)
      const samples = new Uint8Array(analyser.fftSize)
      const tick = () => {
        analyser.getByteTimeDomainData(samples)
        onInputLevel(calculateInputLevel(samples))
        this.inputLevelFrame = window.requestAnimationFrame(tick)
      }
      this.audioContext = audioContext
      this.inputLevelFrame = window.requestAnimationFrame(tick)
    } catch (error) {
      console.warn('[voice] input level meter unavailable:', error)
    }
  }

  private stopInputLevelMeter(): void {
    if (this.inputLevelFrame !== null && typeof window !== 'undefined') {
      window.cancelAnimationFrame(this.inputLevelFrame)
    }
    this.inputLevelFrame = null
    void this.audioContext?.close().catch(() => undefined)
    this.audioContext = null
  }

  private handleFailure(message: string): void {
    if (this.isDisconnecting) return
    console.warn('[voice] realtime transport failure:', message, JSON.stringify(this.describeConnection()))
    const onError = this.onError
    this.disconnect()
    onError?.(new Error(message))
  }

  private handlePeerConnectionStateChange(state: RTCPeerConnectionState): void {
    if (!this.hasOpenedDataChannel) return
    console.info('[voice] peer connection state changed:', JSON.stringify(this.describeConnection()))
    if (state === 'connected') {
      this.clearPeerDisconnectedTimer()
      return
    }
    if (state === 'failed' || state === 'closed') {
      this.handleFailure(`Peer connection ${state}`)
      return
    }
    if (state === 'disconnected') {
      this.schedulePeerDisconnectedTimer()
    }
  }

  private schedulePeerDisconnectedTimer(): void {
    if (this.peerDisconnectedTimeout) return
    this.peerDisconnectedTimeout = this.disconnectClock.setTimeout(() => {
      this.peerDisconnectedTimeout = null
      if (this.peerConnection?.connectionState === 'disconnected') {
        this.handleFailure(`Peer connection disconnected for ${PEER_CONNECTION_DISCONNECTED_GRACE_MS}ms`)
      }
    }, PEER_CONNECTION_DISCONNECTED_GRACE_MS)
  }

  private clearPeerDisconnectedTimer(): void {
    if (this.peerDisconnectedTimeout) this.disconnectClock.clearTimeout(this.peerDisconnectedTimeout)
    this.peerDisconnectedTimeout = null
  }

  private startStatsSampler(): void {
    this.stopStatsSampler()
    void this.sampleConnectionStats('connected')
    this.statsInterval = setInterval(() => {
      void this.sampleConnectionStats('periodic')
    }, CONNECTION_STATS_SAMPLE_MS)
  }

  private stopStatsSampler(): void {
    if (this.statsInterval) clearInterval(this.statsInterval)
    this.statsInterval = null
  }

  private async sampleConnectionStats(reason: string): Promise<void> {
    const pc = this.peerConnection
    if (!pc || this.isDisconnecting) return
    try {
      const stats = await pc.getStats()
      const summary = summarizeRtcStats(stats)
      this.lastConnectionStats = summary
      if (reason !== 'periodic' || pc.connectionState !== 'connected') {
        console.info('[voice] WebRTC stats:', JSON.stringify({ reason, ...this.describeConnection(), stats: summary }))
      }
    } catch (error) {
      console.warn('[voice] failed to sample WebRTC stats:', error)
    }
  }

  private describeConnection(): Record<string, unknown> {
    const now = Date.now()
    return {
      peerConnectionState: this.peerConnection?.connectionState,
      iceConnectionState: this.peerConnection?.iceConnectionState,
      iceGatheringState: this.peerConnection?.iceGatheringState,
      signalingState: this.peerConnection?.signalingState,
      dataChannelState: this.dataChannel?.readyState,
      localTrackEnabled: this.localTrack?.enabled,
      localTrackMuted: this.localTrack?.muted,
      localTrackReadyState: this.localTrack?.readyState,
      micDisabledForMs: this.micDisabledSinceMs !== null ? now - this.micDisabledSinceMs : 0,
      hasOpenedDataChannel: this.hasOpenedDataChannel,
      sessionAgeMs: this.connectedAtMs > 0 ? now - this.connectedAtMs : 0,
      isDisconnecting: this.isDisconnecting,
      lastStats: this.lastConnectionStats,
    }
  }

  private waitForDataChannelOpen(dc: RTCDataChannel, pc: RTCPeerConnection, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (dc.readyState === 'open') {
        resolve()
        return
      }

      let settled = false
      const timeout = setTimeout(() => {
        console.warn('[voice] data channel open timeout:', JSON.stringify(this.describeConnection()))
        settle(new Error('Data channel open timeout'))
      }, DATA_CHANNEL_OPEN_TIMEOUT_MS)

      const cleanup = () => {
        clearTimeout(timeout)
        dc.removeEventListener('open', onOpen)
        dc.removeEventListener('error', onFail)
        pc.removeEventListener('connectionstatechange', onPcChange)
        signal?.removeEventListener('abort', onAbort)
      }

      const settle = (err?: Error) => {
        if (settled) return
        settled = true
        cleanup()
        if (err) reject(err)
        else resolve()
      }

      const onOpen = () => settle()
      const onFail = () => {
        console.warn('[voice] data channel failed before opening:', JSON.stringify(this.describeConnection()))
        settle(new Error('Data channel failed before opening'))
      }
      const onAbort = () => settle(new DOMException('Aborted', 'AbortError'))
      const onPcChange = () => {
        const s = pc.connectionState
        console.info(
          '[voice] peer connection state changed before data channel opened:',
          JSON.stringify(this.describeConnection())
        )
        if (s === 'failed' || s === 'closed') {
          settle(new Error(`Peer connection ${s} before data channel opened`))
        }
      }
      dc.addEventListener('open', onOpen, { once: true })
      dc.addEventListener('error', onFail, { once: true })
      pc.addEventListener('connectionstatechange', onPcChange)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
}
