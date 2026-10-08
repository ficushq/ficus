import { useState } from 'react'
import { usePWA } from '../hooks/usePWA'
import { RefreshIcon } from './icons'

export function UpdateBanner({ usePWA: usePWAProp = usePWA }: { usePWA?: typeof usePWA }) {
  const { updateAvailable, applyUpdate } = usePWAProp()
  const [isApplying, setIsApplying] = useState(false)

  if (!updateAvailable && !isApplying) {
    return null
  }

  const onApplyUpdate = async () => {
    setIsApplying(true)
    try {
      await applyUpdate()
    } catch (error) {
      console.error('[PWA] Failed to apply update:', error)
      setIsApplying(false)
    }
  }

  return (
    <div className="shrink-0 bg-accent text-on-accent px-4 py-2 flex items-center justify-between gap-4">
      <div className="flex items-center gap-2">
        <RefreshIcon className="w-5 h-5 flex-shrink-0" />
        <span className="text-sm font-medium">{isApplying ? 'Applying update…' : 'A new version is available'}</span>
      </div>
      <button
        onClick={onApplyUpdate}
        disabled={isApplying}
        className="ficus-button ficus-button-secondary px-3 py-1 bg-on-accent text-accent rounded text-sm font-medium hover:bg-on-accent/90 transition-colors disabled:opacity-70 disabled:cursor-not-allowed"
      >
        {isApplying ? 'Updating…' : 'Update'}
      </button>
    </div>
  )
}
