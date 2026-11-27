import { SpinnerIcon } from '../icons'

/**
 * Shown while a sandbox-served read waits out a provisioning 503: Core cannot start the sandbox
 * yet and asked to be retried later, which the shared retry policy waits for (client-core
 * retry.ts, isSandboxProvisioningFailure), so the read is still pending rather than failed.
 */
export function SandboxStartingNotice({ subject, className }: { subject: string; className?: string }) {
  return (
    <div role="status" className={className ?? 'flex flex-col items-center justify-center gap-2 p-4 text-center'}>
      <SpinnerIcon className="h-4 w-4 animate-spin text-muted" />
      <p className="text-sm text-secondary">The workspace is starting</p>
      <p className="max-w-xs text-xs text-muted">
        {subject} will load as soon as it is ready. This can take a few minutes.
      </p>
    </div>
  )
}
