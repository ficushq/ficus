import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { CheckIcon, ClipboardIcon } from '../icons'

/**
 * Copies a path the agent can open (e.g. `/private/creds/token.txt`) so it can
 * be pasted into a message to that agent.
 */
export function CopyPathButton({
  path,
  label,
  className,
}: {
  path: string
  /** Visible text; icon-only when omitted. */
  label?: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current)
    },
    []
  )

  const copy = async (event: React.MouseEvent) => {
    event.stopPropagation()
    try {
      await navigator.clipboard.writeText(path)
      setCopied(true)
      if (timer.current) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard unavailable (insecure context or denied): the path stays visible to copy by hand.
    }
  }

  const title = copied ? 'Copied' : `Copy path the agent can open: ${path}`
  return (
    <button
      type="button"
      onClick={copy}
      className={clsx('ficus-button ficus-button-ghost inline-flex items-center gap-1.5 rounded p-1', className)}
      title={title}
      aria-label={label ? undefined : title}
    >
      {copied ? <CheckIcon className="h-3.5 w-3.5" /> : <ClipboardIcon className="h-3.5 w-3.5" />}
      {label && <span className="text-xs">{copied ? 'Copied' : label}</span>}
    </button>
  )
}
