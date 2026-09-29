import { useEffect, useRef, useState } from 'react'

/**
 * A copyable SSH public key display: monospace box + a "Copy" button that
 * flashes "Copied" for 2s. Shared by MachinesSection and RemoteHostsSection
 * (both admin registries) and RemoteHostsSettings (squad surface).
 *
 * Only flips to "Copied" once the write actually resolves — an insecure
 * context (no navigator.clipboard) or a permission-denied rejection must
 * not tell the user the key was copied when it wasn't. Same fix as
 * DeviceCodeStep's copyCode in ProviderAuthSection.tsx; no shared
 * clipboard hook exists yet to dedupe the two against.
 */
export function PublicKeyBlock({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const copiedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (copiedTimeoutRef.current) clearTimeout(copiedTimeoutRef.current)
    }
  }, [])

  const copy = () => {
    if (copiedTimeoutRef.current) clearTimeout(copiedTimeoutRef.current)
    if (!navigator.clipboard) {
      setCopied(false)
      setCopyFailed(true)
      return
    }
    navigator.clipboard.writeText(value).then(
      () => {
        setCopyFailed(false)
        setCopied(true)
        copiedTimeoutRef.current = setTimeout(() => setCopied(false), 2000)
      },
      () => {
        setCopied(false)
        setCopyFailed(true)
      }
    )
  }
  return (
    <div className="space-y-1">
      {label && <p className="font-medium text-secondary">{label}</p>}
      <div className="flex items-start gap-2">
        <code className="flex-1 min-w-0 break-all font-mono text-xs bg-surface-secondary border border-th-border rounded px-2 py-1.5 text-primary">
          {value}
        </code>
        <button
          onClick={copy}
          className="ficus-button text-xs text-accent-light hover:text-link-hover font-medium shrink-0 py-1.5"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {copyFailed && (
        <p className="text-xs text-status-danger-600 dark:text-status-danger-400">
          Couldn&apos;t copy — select the key manually.
        </p>
      )}
    </div>
  )
}
