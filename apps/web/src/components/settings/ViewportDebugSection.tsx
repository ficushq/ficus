import { useEffect, useState } from 'react'

/**
 * Developer tool: overlays live viewport metrics on screen so iOS PWA
 * safe-area/viewport bugs can be diagnosed from a screenshot, without
 * tethering the device to Web Inspector.
 */

interface ViewportMetrics {
  innerWidth: number
  innerHeight: number
  outerHeight: number
  screenWidth: number
  screenHeight: number
  devicePixelRatio: number
  visualViewportHeight: number | null
  visualViewportOffsetTop: number | null
  visualViewportScale: number | null
  safeAreaTop: number
  safeAreaBottom: number
  safeAreaLeft: number
  safeAreaRight: number
  dvh: number
  svh: number
  lvh: number
  htmlClientHeight: number
  bodyClientHeight: number
  rootClientHeight: number
  standaloneMedia: boolean
  navigatorStandalone: boolean
}

function measureProbe(styles: Partial<CSSStyleDeclaration>): number {
  const probe = document.createElement('div')
  probe.style.position = 'fixed'
  probe.style.visibility = 'hidden'
  probe.style.pointerEvents = 'none'
  Object.assign(probe.style, styles)
  document.body.appendChild(probe)
  const value = probe.getBoundingClientRect().height
  probe.remove()
  return Math.round(value * 10) / 10
}

function measureEnvInset(side: 'top' | 'bottom' | 'left' | 'right'): number {
  const probe = document.createElement('div')
  probe.style.position = 'fixed'
  probe.style.visibility = 'hidden'
  probe.style.pointerEvents = 'none'
  probe.style.paddingTop = `env(safe-area-inset-${side}, 0px)`
  document.body.appendChild(probe)
  const value = parseFloat(getComputedStyle(probe).paddingTop) || 0
  probe.remove()
  return Math.round(value * 10) / 10
}

function collectMetrics(): ViewportMetrics {
  return {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    outerHeight: window.outerHeight,
    screenWidth: window.screen?.width ?? 0,
    screenHeight: window.screen?.height ?? 0,
    devicePixelRatio: window.devicePixelRatio,
    visualViewportHeight: window.visualViewport ? Math.round(window.visualViewport.height * 10) / 10 : null,
    visualViewportOffsetTop: window.visualViewport ? Math.round(window.visualViewport.offsetTop * 10) / 10 : null,
    visualViewportScale: window.visualViewport ? window.visualViewport.scale : null,
    safeAreaTop: measureEnvInset('top'),
    safeAreaBottom: measureEnvInset('bottom'),
    safeAreaLeft: measureEnvInset('left'),
    safeAreaRight: measureEnvInset('right'),
    dvh: measureProbe({ height: '100dvh' }),
    svh: measureProbe({ height: '100svh' }),
    lvh: measureProbe({ height: '100lvh' }),
    htmlClientHeight: document.documentElement.clientHeight,
    bodyClientHeight: document.body.clientHeight,
    rootClientHeight: document.getElementById('root')?.clientHeight ?? 0,
    standaloneMedia: window.matchMedia('(display-mode: standalone)').matches,
    navigatorStandalone: (navigator as { standalone?: boolean }).standalone === true,
  }
}

export function ViewportDebugOverlay({ onClose }: { onClose: () => void }) {
  const [metrics, setMetrics] = useState<ViewportMetrics>(() => collectMetrics())

  useEffect(() => {
    const update = () => setMetrics(collectMetrics())
    window.addEventListener('resize', update)
    window.visualViewport?.addEventListener('resize', update)
    const interval = setInterval(update, 2000)
    return () => {
      window.removeEventListener('resize', update)
      window.visualViewport?.removeEventListener('resize', update)
      clearInterval(interval)
    }
  }, [])

  const rows: [string, string | number][] = [
    ['inner W×H', `${metrics.innerWidth} × ${metrics.innerHeight}`],
    ['outer H', metrics.outerHeight],
    ['screen', `${metrics.screenWidth} × ${metrics.screenHeight} @${metrics.devicePixelRatio}x`],
    ['visualViewport H', metrics.visualViewportHeight ?? 'n/a'],
    ['vv offsetTop / scale', `${metrics.visualViewportOffsetTop ?? 'n/a'} / ${metrics.visualViewportScale ?? 'n/a'}`],
    ['env top/bottom', `${metrics.safeAreaTop} / ${metrics.safeAreaBottom}`],
    ['env left/right', `${metrics.safeAreaLeft} / ${metrics.safeAreaRight}`],
    ['100 dvh/svh/lvh', `${metrics.dvh} / ${metrics.svh} / ${metrics.lvh}`],
    ['html/body/#root H', `${metrics.htmlClientHeight} / ${metrics.bodyClientHeight} / ${metrics.rootClientHeight}`],
    ['standalone media/nav', `${metrics.standaloneMedia} / ${metrics.navigatorStandalone}`],
  ]

  return (
    <div
      data-testid="viewport-debug-overlay"
      className="fixed left-2 top-1/4 z-[9999] rounded-lg bg-chrome-scrim/85 p-3 font-mono text-[11px] leading-4 text-status-success-300 shadow-lg"
    >
      <div className="mb-1 flex items-center justify-between gap-4">
        <span className="font-bold text-on-strong">viewport debug</span>
        <button onClick={onClose} className="ficus-button rounded bg-chrome-paper/20 px-2 text-on-strong">
          ×
        </button>
      </div>
      {rows.map(([label, value]) => (
        <div key={label} className="flex justify-between gap-3">
          <span className="text-status-success-500/80">{label}</span>
          <span>{value}</span>
        </div>
      ))}
    </div>
  )
}

export function ViewportDebugSection() {
  const [enabled, setEnabled] = useState(false)

  return (
    <div className="ficus-section py-5">
      <h4 className="text-md font-medium text-primary mb-4">Viewport Debug</h4>
      <div className="space-y-4">
        <p className="text-sm text-muted">
          Overlay live viewport and safe-area metrics for diagnosing PWA layout issues. Screenshot the overlay to share
          the values.
        </p>
        <button
          onClick={() => setEnabled((v) => !v)}
          className="ficus-button px-4 py-2.5 md:py-2 bg-surface-secondary hover:bg-surface-hover rounded-md text-sm font-medium text-primary min-h-[44px] md:min-h-0"
        >
          {enabled ? 'Hide overlay' : 'Show overlay'}
        </button>
      </div>
      {enabled && <ViewportDebugOverlay onClose={() => setEnabled(false)} />}
    </div>
  )
}
