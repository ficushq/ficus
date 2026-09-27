import { useEffect, useState } from 'react'
import type { RenderedPairing } from './pairingQr'

// The deep link only resolves on a phone with the Ficus app installed; hide it on desktop.
const IS_MOBILE = typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)

/**
 * A minted pairing code as the person pairing sees it: the QR, a countdown to
 * its expiry, the raw code to copy, and the deep link on a phone. Calls
 * `onExpired` once the countdown reaches zero so the owner can clear it.
 */
export function PairingCode({
  pairing,
  onExpired,
  onRegenerate,
  regenerating,
  hint = 'Scan with the Ficus app.',
}: {
  pairing: RenderedPairing & { code: string }
  onExpired: () => void
  onRegenerate: () => void
  regenerating: boolean
  hint?: string
}) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    const interval = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [pairing])

  const secondsLeft = Math.max(0, Math.round((pairing.expiresAt - now) / 1000))
  useEffect(() => {
    if (secondsLeft === 0) onExpired()
  }, [secondsLeft, onExpired])

  return (
    <div className="flex flex-col items-center gap-2">
      <img src={pairing.dataUrl} alt="Pairing QR code" className="rounded bg-white p-2" width={240} height={240} />
      <p className="text-xs text-muted">
        {hint} Expires in <span className="font-mono">{secondsLeft}s</span>.
      </p>
      <div className="flex items-center gap-2">
        <code className="rounded bg-surface-hover px-2 py-1 text-xs select-all">{pairing.code}</code>
        <button
          className="ficus-button text-xs text-secondary"
          onClick={() => navigator.clipboard.writeText(pairing.code)}
        >
          Copy code
        </button>
      </div>
      {IS_MOBILE && (
        <a
          href={pairing.deepLink}
          className="px-3 py-1.5 text-sm font-medium text-on-accent bg-accent rounded-md hover:bg-accent-hover"
        >
          Open in the Ficus app
        </a>
      )}
      <button
        onClick={onRegenerate}
        disabled={regenerating}
        className="ficus-button text-xs text-secondary hover:text-primary"
      >
        Regenerate
      </button>
    </div>
  )
}
