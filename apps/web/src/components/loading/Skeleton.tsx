import type { ReactNode } from 'react'
import clsx from 'clsx'

export function SkeletonBlock({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" className={clsx('motion-safe:animate-pulse rounded-md bg-surface-secondary', className)} />
  )
}

export function SkeletonLine({ className }: { className?: string }) {
  return <SkeletonBlock className={clsx('h-3', className)} />
}

export function SkeletonCard({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div aria-hidden="true" className={clsx('ficus-panel p-4', className)}>
      {children}
    </div>
  )
}

export function LoadingSurface({
  label,
  className,
  children,
}: {
  label: string
  className?: string
  children: ReactNode
}) {
  return (
    <div role="status" aria-label={label} aria-busy="true" className={className}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  )
}

export function SkeletonRows({ count, children }: { count: number; children: (index: number) => ReactNode }) {
  return Array.from({ length: count }, (_, index) => children(index))
}

export function CollectionSkeleton({
  label,
  count,
  layout = 'list',
}: {
  label: string
  count: number
  layout?: 'list' | 'cards'
}) {
  return (
    <LoadingSurface
      label={label}
      className={layout === 'cards' ? 'grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3' : 'space-y-2'}
    >
      <SkeletonRows count={Math.max(1, count)}>
        {(index) => (
          <SkeletonCard key={index} className="min-h-16 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <SkeletonLine className={index % 2 ? 'w-2/5' : 'w-3/5'} />
              <SkeletonBlock className="h-5 w-14 rounded-full" />
            </div>
            <SkeletonLine className="w-4/5" />
          </SkeletonCard>
        )}
      </SkeletonRows>
    </LoadingSurface>
  )
}

export function FormSkeleton({ label, sections = 3 }: { label: string; sections?: number }) {
  return (
    <LoadingSurface label={label} className="space-y-4">
      <SkeletonRows count={sections}>
        {(index) => (
          <div key={index} className="space-y-2">
            <SkeletonLine className={index % 2 ? 'w-28' : 'w-36'} />
            <SkeletonBlock className="h-10 w-full" />
          </div>
        )}
      </SkeletonRows>
    </LoadingSurface>
  )
}

export function DocumentSkeleton({
  label,
  lines = 12,
  className,
}: {
  label: string
  lines?: number
  className?: string
}) {
  return (
    <LoadingSurface label={label} className={clsx('h-full space-y-3 overflow-hidden p-4', className)}>
      <SkeletonRows count={lines}>
        {(index) => (
          <div key={index} className="flex items-center gap-3">
            <SkeletonBlock className="h-3 w-5 shrink-0 opacity-60" />
            <SkeletonLine
              className={clsx(
                index % 5 === 0 ? 'w-2/5' : index % 3 === 0 ? 'w-3/5' : index % 2 === 0 ? 'w-4/5' : 'w-2/3'
              )}
            />
          </div>
        )}
      </SkeletonRows>
    </LoadingSurface>
  )
}

export function CanvasSkeleton({ label, className }: { label: string; className?: string }) {
  return (
    <LoadingSurface
      label={label}
      className={clsx('relative min-h-64 overflow-hidden rounded-lg bg-surface-secondary', className)}
    >
      <SkeletonBlock className="absolute left-[12%] top-[18%] h-14 w-28 rounded-xl" />
      <SkeletonBlock className="absolute left-[42%] top-[38%] h-16 w-32 rounded-xl" />
      <SkeletonBlock className="absolute right-[10%] top-[16%] h-12 w-24 rounded-xl" />
      <SkeletonBlock className="absolute bottom-[14%] left-[24%] h-12 w-24 rounded-xl" />
      <SkeletonBlock className="absolute bottom-[12%] right-[18%] h-14 w-28 rounded-xl" />
    </LoadingSurface>
  )
}

export function ChatSkeleton({ label, className }: { label: string; className?: string }) {
  return (
    <LoadingSurface label={label} className={clsx('flex min-h-64 flex-1 flex-col', className)}>
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-th-border px-4">
        <SkeletonBlock className="h-8 w-8 rounded-full" />
        <SkeletonLine className="w-36" />
      </div>
      <div className="flex flex-1 flex-col justify-end gap-4 p-4">
        <SkeletonCard className="w-3/5 space-y-2 self-start border-0 bg-surface-secondary">
          <SkeletonLine className="w-full" />
          <SkeletonLine className="w-3/4" />
        </SkeletonCard>
        <SkeletonCard className="w-2/5 space-y-2 self-end border-0 bg-accent/10">
          <SkeletonLine className="w-4/5" />
        </SkeletonCard>
        <SkeletonCard className="w-2/3 space-y-2 self-start border-0 bg-surface-secondary">
          <SkeletonLine className="w-full" />
          <SkeletonLine className="w-5/6" />
          <SkeletonLine className="w-2/5" />
        </SkeletonCard>
      </div>
      <div className="m-4 h-12 shrink-0 rounded-lg border border-th-border bg-surface-secondary" />
    </LoadingSurface>
  )
}

/** Message shapes only: the agent header and composer remain in place while history loads. */
export function ConversationSkeleton() {
  return (
    <LoadingSurface label="Loading conversation" className="flex min-h-48 flex-col gap-7 py-3">
      <div aria-hidden="true" className="w-3/5 max-w-sm self-end rounded-xl bg-selection p-4 space-y-2">
        <SkeletonLine className="w-full" />
        <SkeletonLine className="w-2/3" />
      </div>
      <div aria-hidden="true" className="w-5/6 max-w-2xl space-y-3">
        <SkeletonLine className="w-20 opacity-60" />
        <SkeletonLine className="w-full" />
        <SkeletonLine className="w-11/12" />
        <SkeletonLine className="w-3/4" />
      </div>
      <div aria-hidden="true" className="w-3/4 max-w-xl space-y-3">
        <SkeletonLine className="w-full" />
        <SkeletonLine className="w-4/5" />
      </div>
    </LoadingSurface>
  )
}

/** Keep the surrounding layout and static controls mounted while this data region resolves. */
export function LoadingContent({
  loading,
  fallback,
  children,
}: {
  loading: boolean
  fallback: ReactNode
  children: ReactNode
}) {
  return <>{loading ? fallback : children}</>
}

/** Inline placeholder preserving the real text line box, including inside headings and paragraphs. */
export function SkeletonText({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={clsx(
        'inline-block h-3 rounded-md bg-surface-secondary align-middle motion-safe:animate-pulse',
        className
      )}
    />
  )
}
