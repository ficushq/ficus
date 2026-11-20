// Real Settings → Logs section and styles in a copy of the app shell's layout, fed by a fake log socket.
// No backend: the WebSocket is replaced before render and the ws-ticket request is answered by the check.
import { createRoot } from 'react-dom/client'
import { SettingsSearchDestination } from '../../src/components/settings/SettingsSearchDestination'
import { SystemLogsSection } from '../../src/components/settings/SystemLogsSection'
import { applyResolvedTheme } from '../../src/theme/apply'
import { FICUS_THEME } from '../../src/theme/registry'
import '../../src/index.css'

applyResolvedTheme(
  document.documentElement,
  FICUS_THEME,
  new URLSearchParams(location.search).get('appearance') === 'dark' ? 'dark' : 'light'
)

const RELEASE = '/opt/ficus-core/releases/8c40afd715124b66de31e44746f6726d7730332d-51ff3dff76b9/apps/core/dist/index.js'
const time = (second: number) =>
  `2026-11-20T09:07:${String(second % 60).padStart(2, '0')}.${String(second * 37)
    .padStart(3, '0')
    .slice(-3)}Z`

/** Representative pm2 output: HTTP access lines, scheduler noise, a warning and a Bun error dump. */
function sampleLog(count: number): string {
  const lines: string[] = []
  for (let i = 0; i < count; i++) {
    const t = time(i)
    switch (i % 9) {
      case 0:
        lines.push(
          `[api] ${t} [http]                   --> GET /api/agents?parentAgentId=b4b8dd88-e119-4c88-9c56-f15c16c0f375&limit=50 200 ${12 + i}ms`
        )
        break
      case 1:
        lines.push(`[worker] ${t} [scheduler]              tick: 3 schedules due, 0 claimed by another worker`)
        break
      case 2:
        lines.push(`[api] ${t} [ws]                     client connected (agent=dff91698, squads=1)`)
        break
      case 3:
        lines.push(`[worker] ${t} [queue]                  delivered message 984f5231 to agent dff91698 in 41ms`)
        break
      case 4:
        lines.push(
          `[api] ${t} [http]                   --> POST /api/work-streams/e3e4653f-fa43-47bc-baad-b35d8727ac8b/advance 200 87ms`
        )
        break
      case 5:
        lines.push(`[worker] ${t} [storage] Warning: host-noah is 78.7% full; the 80% warning clears below 77%`)
        break
      case 6:
        lines.push(
          `[api] ${t} [http]                   --> GET /api/agents?parentAgentId=b4b8dd88-e119-4c88-9c56-f15c16c0f375 500 133ms`
        )
        break
      case 7:
        lines.push(
          `[api] error: Unknown model 'gpt-5.4-mini' for provider 'openai-codex'`,
          `[api]       at validateModelSpec (${RELEASE}:376956:20)`,
          `[api]       at resolveAgentModelSpec (${RELEASE}:376960:65)`,
          `[api]       at processTicksAndRejections (native:7:39)`
        )
        break
      default:
        lines.push(
          `[worker] ${t} [sandbox]                box squad_4ea8b934 healthy (cpu 31%, memory 2.1 GiB of 8 GiB)`
        )
    }
  }
  return lines.join('\n') + '\n'
}

type Listener = ((event: { data: unknown; code?: number }) => void) | null

/** The section's only dependency on the server: emits a control frame, then the sample tail. */
class FakeLogSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static current: FakeLogSocket | null = null
  readyState = FakeLogSocket.CONNECTING
  binaryType = 'blob'
  onopen: Listener = null
  onmessage: Listener = null
  onerror: Listener = null
  onclose: Listener = null
  constructor(readonly url: string) {
    FakeLogSocket.current = this
    setTimeout(() => {
      this.readyState = FakeLogSocket.OPEN
      this.onopen?.({ data: null })
      this.onmessage?.({ data: JSON.stringify({ type: 'info', message: 'Streaming system logs via pm2' }) })
      this.emit(sampleLog(Number(new URLSearchParams(location.search).get('lines') ?? 120)))
    }, 0)
  }
  emit(text: string) {
    this.onmessage?.({ data: new TextEncoder().encode(text).buffer })
  }
  close() {
    this.readyState = FakeLogSocket.CLOSED
  }
}

Object.assign(window, {
  WebSocket: FakeLogSocket,
  /** Lets the check stream more lines on demand. */
  emitSystemLog: (text: string) => FakeLogSocket.current?.emit(text),
})

// Class names copied from App.tsx (shell, main) and SettingsPage.tsx (settings row and content column).
createRoot(document.getElementById('root')!).render(
  <div className="h-dvh max-h-full overflow-hidden flex flex-col bg-page text-primary">
    <header className="h-14 shrink-0 flex items-center px-6 font-semibold border-b border-th-border">Ficus</header>
    <div className="grow min-h-0 flex flex-col overflow-hidden">
      <main
        data-testid="app-scroll-container"
        className="grow min-h-0 flex flex-col overflow-y-auto max-w-7xl w-full mx-auto p-4 md:pt-6 md:px-6"
      >
        <div className="h-full min-h-0 flex flex-col md:flex-row grow gap-4 md:gap-6">
          <nav aria-label="Settings" className="ficus-panel shrink-0 p-4 text-sm text-muted md:w-64">
            Settings navigation
          </nav>
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
            <SettingsSearchDestination section="system-logs" fill>
              <SystemLogsSection />
            </SettingsSearchDestination>
          </div>
        </div>
        <footer className="hidden md:flex shrink-0 justify-center pt-4 text-xs text-muted">Keyboard shortcuts</footer>
      </main>
    </div>
  </div>
)
