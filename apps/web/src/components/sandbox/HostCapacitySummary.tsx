import type { SandboxHostCapacity, SandboxPressure } from '@ficus/shared'

/** Host load is measured; quota is a forecast of admitted box demand. Never
 * attribute either to this squad's workload or present a missing sample as zero. */
export function HostCapacitySummary({
  capacity,
  pressure,
}: {
  capacity?: SandboxHostCapacity
  pressure?: SandboxPressure
}) {
  if (!capacity && !pressure) return null
  const load =
    pressure && pressure.cpus > 0 && Number.isFinite(pressure.load[0]) ? pressure.load[0] / pressure.cpus : undefined
  const known =
    capacity?.reason !== 'unknown' &&
    capacity?.cpus !== undefined &&
    capacity.budgetCpus !== undefined &&
    capacity.activeQuotaCpus !== undefined
  const full = known && capacity.activeQuotaCpus! >= capacity.budgetCpus!
  const labels = [
    ...(load === undefined ? [] : [`Host load ${load.toFixed(1)}×`]),
    ...(capacity
      ? [
          known
            ? `${load === undefined ? 'Host ' : ''}quota ${capacity.activeQuotaCpus}/${capacity.budgetCpus} CPUs`
            : 'Host quota unknown',
        ]
      : []),
  ]
  if (!labels.length) return null
  const details = [
    ...(load === undefined
      ? []
      : ['Host load is the 1-minute load average divided by host CPUs; it includes other boxes.']),
    ...(pressure && pressure.memTotalMb > 0 && Number.isFinite(pressure.memAvailableMb)
      ? [`Host memory ${Math.round(100 * (1 - pressure.memAvailableMb / pressure.memTotalMb))}% used.`]
      : []),
    ...(known
      ? [
          `Reserved box CPU quotas / admission budget (${capacity.budgetCpus! / capacity.cpus!}× host CPUs); not measured CPU usage. Per-box CPU quotas are unchanged.`,
        ]
      : capacity
        ? ['Host CPU facts are unavailable; new demand waits rather than guessing capacity.']
        : []),
    ...(full ? ['Additional box demand waits for capacity; already-accounted work can continue.'] : []),
  ]
  return (
    <span
      className={`border-l border-current/20 pl-1.5 ${full ? 'text-status-attention-fg' : 'text-secondary'}`}
      title={details.join(' ')}
    >
      {labels.join(' · ')}
    </span>
  )
}
