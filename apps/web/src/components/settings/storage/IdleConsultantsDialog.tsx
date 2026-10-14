import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { DEFAULT_CONSULTANT_IDLE_DORMANCY_DAYS, type StorageSquad } from '@ficus/shared'
import { makeIdleConsultantsDormantInChunks } from '../../../api/system'
import { queries } from '../../../queryOptions'
import { ConfirmStorageAction } from './ConfirmStorageAction'
import { daysAgoLabel, idleDormancySummary, parseIdleDays, storageSize, sumBytes } from './format'

interface Props {
  squad: StorageSquad
  retentionDays: number
  onClose: () => void
  onDone: (message: string) => void
}

/** Preview consultants idle at least N days, then make exactly those (still idle) dormant. */
export function IdleConsultantsDialog({ squad, retentionDays, onClose, onDone }: Props) {
  const [raw, setRaw] = useState(String(DEFAULT_CONSULTANT_IDLE_DORMANCY_DAYS))
  const [progress, setProgress] = useState<string | null>(null)
  const days = parseIdleDays(raw)
  const preview = useQuery({ ...queries.system.idleConsultants(squad.id, days ?? 0), enabled: days !== null })
  const consultants = days !== null ? (preview.data?.agents ?? []) : []
  const total = storageSize(sumBytes(consultants))
  return (
    <ConfirmStorageAction
      isOpen
      onClose={onClose}
      title={`Make idle consultants dormant in ${squad.name}`}
      confirmLabel={`Make ${consultants.length} dormant`}
      disabled={days === null || preview.isPending || consultants.length === 0}
      action={() => {
        setProgress(`Made 0 of ${consultants.length} dormant…`)
        return makeIdleConsultantsDormantInChunks(
          squad.id,
          days!,
          consultants.map((consultant) => consultant.id),
          (made, total) => setProgress(`Made ${made} of ${total} dormant…`)
        )
      }}
      onDone={(result) => onDone(idleDormancySummary(result))}
    >
      <label className="block space-y-1">
        <span className="text-primary">Idle for at least (days)</span>
        <input
          className="ficus-field block w-32 px-3 py-2"
          type="number"
          min={1}
          max={3650}
          step={1}
          value={raw}
          aria-invalid={days === null}
          onChange={(event) => setRaw(event.target.value)}
        />
      </label>
      <p>
        A consultant is idle when it has had no message in that many days, or was never messaged and was created that
        long ago. Consultants that are working right now are never included.
      </p>
      {progress && (
        <p role="status" className="text-primary">
          {progress}
        </p>
      )}
      {days === null && <p className="text-status-danger-400">Enter a whole number of days from 1 to 3650.</p>}
      {preview.isError && <p className="text-status-danger-400">Could not load idle consultants.</p>}
      {days !== null && preview.isSuccess && consultants.length === 0 && (
        <p>No consultants in this squad have been idle that long.</p>
      )}
      {consultants.length > 0 && (
        <>
          <ul className="max-h-60 divide-y divide-th-border overflow-y-auto rounded-lg border border-th-border">
            {consultants.map((consultant) => (
              <li key={consultant.id} className="flex items-baseline justify-between gap-4 px-3 py-2">
                <span className="min-w-0">
                  <span className="block break-words text-primary">{consultant.label}</span>
                  <span className="block text-xs">
                    {consultant.lastMessageAt
                      ? `Last active ${daysAgoLabel(consultant.lastMessageAt)}`
                      : `Never messaged · created ${daysAgoLabel(consultant.createdAt)}`}
                  </span>
                </span>
                <span className="shrink-0 tabular-nums">
                  {consultant.bytes === null ? 'Not measured' : storageSize(consultant.bytes)}
                </span>
              </li>
            ))}
          </ul>
          <p>
            These {consultants.length} consultants stop and release their compute; a new message wakes one again. No
            space is freed now: their files ({total} measured) stay on disk until they are removed automatically{' '}
            {retentionDays} days after becoming dormant.
          </p>
        </>
      )}
    </ConfirmStorageAction>
  )
}
