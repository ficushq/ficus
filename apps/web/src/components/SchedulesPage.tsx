import { useState } from 'react'
import { SchedulesList, CreateScheduleModal } from './schedules'
import { usePermissions } from '../hooks/usePermissions'

export function SchedulesPage() {
  const [showCreate, setShowCreate] = useState(false)
  const { can, isLoading: permissionsLoading } = usePermissions()
  const canCreateSchedule = !permissionsLoading && can('schedules:create')

  return (
    <>
      <div className="flex justify-between items-center gap-3 mb-4">
        <h2 className="text-lg font-semibold text-primary">Schedules</h2>
        {canCreateSchedule && (
          <button
            onClick={() => setShowCreate(true)}
            className="ficus-button ficus-button-primary px-3 py-1.5 rounded-md text-sm font-medium"
          >
            New Schedule
          </button>
        )}
      </div>

      <SchedulesList />

      {canCreateSchedule && <CreateScheduleModal isOpen={showCreate} onClose={() => setShowCreate(false)} />}
    </>
  )
}
