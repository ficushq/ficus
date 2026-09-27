import type { DeviceAuthorizationPreview } from '../../api/devices'
import { LoadingSurface, SkeletonBlock, SkeletonLine } from '../loading/Skeleton'

export function DeviceAuthorizationApproval(props: {
  preview?: DeviceAuthorizationPreview
  isLoading?: boolean
  invalid?: boolean
  isPending?: boolean
  isSuccess?: boolean
  error?: string | null
  onApprove: () => void
}) {
  return (
    <div className="rounded-lg border border-accent bg-surface p-4 space-y-2">
      <h3 className="text-sm font-medium text-primary">
        {props.preview?.platform === 'desktop' ? 'Approve Ficus Desktop sign-in' : 'Approve Ficus CLI login'}
      </h3>
      {props.isLoading ? (
        <LoadingSurface label="Loading authorization request" className="space-y-3 py-1">
          <SkeletonLine className="w-4/5" />
          <SkeletonLine className="w-2/3" />
          <SkeletonBlock className="h-9 w-24" />
        </LoadingSurface>
      ) : props.invalid ? (
        <p className="text-sm text-status-danger-600">This authorization request is invalid or expired.</p>
      ) : props.preview ? (
        <>
          <p className="text-sm text-muted">
            Approve <strong>{props.preview.name}</strong> to access this account. This request expires{' '}
            {new Date(props.preview.expiresAt).toLocaleString()}.
          </p>
          {props.error && <p className="text-sm text-status-danger-600 dark:text-status-danger-400">{props.error}</p>}
          <button
            onClick={props.onApprove}
            disabled={props.isPending || props.isSuccess}
            className="ficus-button ficus-button-primary px-3 py-1.5 text-sm font-medium text-on-accent bg-accent rounded-md disabled:opacity-50"
          >
            {props.isSuccess ? 'Approved' : props.isPending ? 'Approving…' : 'Approve'}
          </button>
        </>
      ) : null}
    </div>
  )
}
