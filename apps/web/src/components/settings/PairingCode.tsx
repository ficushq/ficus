import { useEffect, useState } from 'react'
import { canOpenFicusApp, type RenderedPairing } from './pairingQr'

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
  const [openInApp] = useState(canOpenFicusApp)
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
          className="ficus-button ficus-button-link text-xs"
          onClick={() => navigator.clipboard.writeText(pairing.code)}
        >
          Copy code
        </button>
      </div>
      {openInApp && (
        <a
          href={pairing.deepLink}
          className="ficus-button ficus-button-primary px-4 py-2 text-sm font-medium rounded-md"
        >
          Open in Ficus app
        </a>
      )}
      <button onClick={onRegenerate} disabled={regenerating} className="ficus-button ficus-button-link text-xs">
        Regenerate
      </button>
    </div>
  )
}
