import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { queries } from '../../queryOptions'
import { CheckIcon } from '../icons'
import { AgentQuestionCard } from '../AgentQuestionCard'
import { LoadingSurface, SkeletonBlock, SkeletonLine, SkeletonRows } from '../loading/Skeleton'

interface Props {
  agentId: string
}

export function AgentContextPanel({ agentId }: Props) {
  const { data, isLoading, error } = useQuery({
    ...queries.agents.context(agentId),
    refetchInterval: 5000,
  })
  const { data: answeredQuestions = [] } = useQuery({
    ...queries.agentQuestions.byAgent(agentId, 'answered'),
    refetchInterval: 30000,
  })

  if (isLoading) {
    return (
      <LoadingSurface label="Loading agent context" className="h-full space-y-4 overflow-hidden p-4">
        <div className="overflow-hidden rounded-lg border border-th-border">
          <div className="border-b border-th-border px-3 py-2 text-sm font-medium text-primary">Short-term Memory</div>
          <div className="space-y-2 p-3">
            <SkeletonRows count={4}>
              {(index) => <SkeletonLine key={index} className={index === 3 ? 'w-2/5' : 'w-full'} />}
            </SkeletonRows>
          </div>
        </div>
        <div className="overflow-hidden rounded-lg border border-th-border">
          <div className="border-b border-th-border px-3 py-2 text-sm font-medium text-primary">Todos</div>
          <div className="space-y-3 p-3">
            <SkeletonRows count={3}>
              {(index) => (
                <div key={index} className="flex items-center gap-2">
                  <SkeletonBlock className="h-4 w-4 shrink-0" />
                  <SkeletonLine className={index % 2 ? 'w-3/5' : 'w-4/5'} />
                </div>
              )}
            </SkeletonRows>
          </div>
        </div>
      </LoadingSurface>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-status-danger-500">Failed to load agent context</div>
    )
  }

  const hasMemory = data?.shortTermMemory && data.shortTermMemory.trim().length > 0
  const hasTodos = data?.todos && data.todos.length > 0

  return (
    <div className="h-full overflow-y-auto p-4 space-y-4">
      {/* Short-term Memory */}
      <div className="border border-th-border rounded-lg overflow-hidden">
        <div className="px-3 py-2 border-b border-th-border">
          <h3 className="text-sm font-medium text-primary">Short-term Memory</h3>
        </div>
        <div className="p-3">
          {hasMemory ? (
            <pre className="text-sm text-secondary whitespace-pre-wrap font-mono bg-surface-secondary rounded p-3 overflow-x-auto">
              {data.shortTermMemory}
            </pre>
          ) : (
            <p className="text-sm text-muted italic">No short-term memory stored</p>
          )}
        </div>
      </div>

      {/* Todos */}
      <div className="border border-th-border rounded-lg overflow-hidden">
        <div className="px-3 py-2 border-b border-th-border">
          <h3 className="text-sm font-medium text-primary">
            Todos {hasTodos && <span className="text-muted font-normal">({data.todos.length})</span>}
          </h3>
        </div>
        <div className="p-3">
          {hasTodos ? (
            <ul className="space-y-2">
              {data.todos.map((todo, index) => {
                const unmetDeps = todo.depends.filter((dep) => {
                  const depItem = data.todos[dep - 1]
                  return depItem && !depItem.completed
                })
                const isBlocked = unmetDeps.length > 0

                return (
                  <li key={index} className={clsx('flex items-start gap-2 text-sm', todo.completed && 'opacity-60')}>
                    <span
                      className={clsx(
                        'mt-0.5 w-4 h-4 rounded border flex items-center justify-center shrink-0',
                        todo.completed
                          ? 'bg-status-success-500 border-status-success-500 text-on-strong'
                          : isBlocked
                            ? 'border-status-external-wait-400 dark:border-status-external-wait-500 bg-status-external-wait-50 dark:bg-status-external-wait-900/30'
                            : 'border-th-border'
                      )}
                    >
                      {todo.completed && <CheckIcon className="w-3 h-3" />}
                    </span>
                    <div className="flex-1 min-w-0">
                      <span className={clsx('text-primary', todo.completed && 'line-through text-muted!')}>
                        {index + 1}. {todo.text}
                      </span>
                      {todo.depends.length > 0 && (
                        <span className="ml-2 text-xs text-muted">(depends: {todo.depends.join(', ')})</span>
                      )}
                      {isBlocked && !todo.completed && (
                        <span className="ml-2 text-xs text-status-external-wait-600 dark:text-status-external-wait-400">
                          blocked
                        </span>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="text-sm text-muted italic">No active todos</p>
          )}
        </div>
      </div>

      {/* Terminal question history (answered and dismissed) */}
      {answeredQuestions.length > 0 && (
        <div className="border border-th-border rounded-lg overflow-hidden">
          <div className="px-3 py-2 border-b border-th-border">
            <h3 className="text-sm font-medium text-primary">
              Questions <span className="text-muted font-normal">({answeredQuestions.length})</span>
            </h3>
          </div>
          <div className="p-3 space-y-2">
            {answeredQuestions.map((q) => (
              <AgentQuestionCard key={q.id} question={q} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
