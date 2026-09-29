import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { useURLState } from '../../hooks/useURLState'
import { useSquadSlugs } from '../../hooks/useSquadSlugs'
import { queries } from '../../queryOptions'
import { MemoryFileViewer } from './MemoryFileViewer'
import { MemorySearchPanel } from './MemorySearchPanel'
import { FileIcon } from '../icons'
import { MemoryTree } from './MemoryTree'

export function MemoryTab({ squadId }: { squadId: string }) {
  const { slugFor } = useSquadSlugs()
  const [mobilePane, setMobilePane] = useState<'files' | 'viewer'>('files')
  const [selectedFile, setSelectedFile] = useURLState<string | null>({
    param: 'memoryFile',
    defaultValue: null,
    serialize: (v) => v,
    deserialize: (v) => v,
  })

  const { data: inboundGrants = [] } = useQuery(queries.squads.grants.inbound(squadId))
  const { data: allSquads = [] } = useQuery(queries.squads.list('active'))
  const sourceNames = useMemo(
    () =>
      inboundGrants
        .map((grant) => allSquads.find((squad) => squad.id === grant.sourceSquadId)?.name)
        .filter((name): name is string => !!name),
    [allSquads, inboundGrants]
  )

  const handleSelectFile = (path: string) => {
    setSelectedFile(path)
    setMobilePane('viewer')
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      {inboundGrants.length > 0 && (
        <div className="shrink-0 mb-3 px-3 py-2 text-xs text-muted">
          <span className="text-muted">Searches also include memory granted by: </span>
          <span className="text-primary">{sourceNames.join(', ') || `${inboundGrants.length} squad(s)`}</span>
          <Link to={`/squads/${slugFor(squadId)}/sharing`} className="ml-2 text-accent-light hover:underline">
            Manage
          </Link>
        </div>
      )}
      <MemorySearchPanel squadId={squadId} />
      <div className="flex-1 min-h-0 flex flex-col md:flex-row gap-3">
        <div
          className={clsx(
            'flex-1 min-h-0 md:w-64 md:flex-none overflow-hidden rounded-xl bg-surface',
            selectedFile && mobilePane === 'viewer' && 'hidden md:block'
          )}
        >
          <MemoryTree squadId={squadId} onSelectFile={handleSelectFile} selectedPath={selectedFile ?? undefined} />
        </div>
        <div
          className={clsx(
            'flex-1 min-w-0 overflow-hidden rounded-xl',
            (!selectedFile || mobilePane === 'files') && 'hidden md:block'
          )}
        >
          {selectedFile ? (
            <>
              <button
                onClick={() => setMobilePane('files')}
                className="ficus-button md:hidden shrink-0 w-full px-3 py-2 text-sm text-accent-light hover:text-link-hover border-b border-th-border bg-surface text-left"
              >
                ← Back to memory
              </button>
              <div className="h-[calc(100%-37px)] md:h-full">
                <MemoryFileViewer squadId={squadId} filePath={selectedFile} />
              </div>
            </>
          ) : (
            <div className="h-full flex flex-col items-center justify-center gap-3 px-6 text-center">
              <FileIcon className="h-7 w-7 text-muted" />
              <p className="text-sm font-medium text-secondary">Select a memory file to view</p>
              <p className="text-xs text-muted">Browse the context and knowledge your squad keeps.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
