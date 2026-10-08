import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { queries } from '../../queryOptions'
import { queryKeys } from '../../queryKeys'
import { revokeSession, revokeAllSessions } from '../../api/sessions'
import type { SessionSummary } from '../../api/sessions'
import { useLoadingShapeCount } from '../../hooks/useLoadingShapeCount'
import { CollectionSkeleton } from '../loading/Skeleton'

export function SessionsSection() {
  const queryClient = useQueryClient()
  const { data: sessions = [], isLoading } = useQuery(queries.sessions.list())
  const loadingRowCount = useLoadingShapeCount('settings:sessions', isLoading ? undefined : sessions.length, {
    fallbackCount: 3,
    maxCount: 8,
  })

  const revokeMutation = useMutation({
    mutationFn: revokeSession,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sessions.all })
    },
  })

  const revokeAllMutation = useMutation({
    mutationFn: revokeAllSessions,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sessions.all })
    },
  })

  if (isLoading) {
    return <CollectionSkeleton label="Loading sessions" count={loadingRowCount} />
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-lg font-semibold text-primary">Sessions</h3>
          <p className="text-sm text-muted mt-1">View and manage your active sessions.</p>
        </div>
        {sessions.length > 0 && (
          <button
            onClick={() => {
              if (confirm('Revoke all sessions? You will be logged out.')) {
                revokeAllMutation.mutate()
              }
            }}
            disabled={revokeAllMutation.isPending}
            className="ficus-button ficus-button-danger px-4 py-2.5 md:py-2 rounded-md text-sm font-medium min-h-[44px] md:min-h-0 disabled:opacity-50"
          >
            {revokeAllMutation.isPending ? 'Revoking...' : 'Revoke All'}
          </button>
        )}
      </div>

      <div className="ficus-section overflow-hidden">
        {sessions.length === 0 ? (
          <div className="px-4 py-8 text-center text-muted text-sm">No active sessions.</div>
        ) : (
          <div className="divide-y divide-th-border">
            {sessions.map((session: SessionSummary) => (
              <div key={session.id} className="px-4 py-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-primary">
                      {session.userAgent ? parseUserAgent(session.userAgent) : 'Unknown device'}
                    </p>
                    <div className="flex items-center gap-3 mt-0.5">
                      {session.createdAt && (
                        <span className="text-xs text-muted">
                          Created {new Date(session.createdAt).toLocaleDateString()}
                        </span>
                      )}
                      {session.expiresAt && (
                        <span className="text-xs text-muted">
                          Expires {new Date(session.expiresAt).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                    {session.userAgent && (
                      <p className="text-xs text-muted mt-0.5 truncate max-w-md">{session.userAgent}</p>
                    )}
                  </div>
                  <button
                    onClick={() => revokeMutation.mutate(session.id)}
                    disabled={revokeMutation.isPending}
                    aria-label={`Revoke session on ${session.userAgent ? parseUserAgent(session.userAgent) : 'unknown device'}`}
                    className="ficus-button ficus-button-danger px-2 py-1 text-xs font-medium shrink-0 sm:ml-4 min-h-[44px] sm:min-h-0 disabled:opacity-50"
                  >
                    Revoke
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function parseUserAgent(ua: string): string {
  if (ua.includes('Chrome')) return 'Chrome'
  if (ua.includes('Firefox')) return 'Firefox'
  if (ua.includes('Safari')) return 'Safari'
  if (ua.includes('Edge')) return 'Edge'
  return 'Browser'
}
