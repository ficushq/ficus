import type { SandboxHostCapacity, SandboxPressure } from '@ficus/shared'

/** Load is measured across the host; tracked boxes share CPUs, not reserve them. */
export function HostCapacitySummary({
  capacity,
  pressure,
}: {
  capacity?: SandboxHostCapacity
  pressure?: SandboxPressure
}) {
  const load =
    pressure && pressure.cpus > 0 && Number.isFinite(pressure.load[0]) ? pressure.load[0] / pressure.cpus : undefined
  const labels = [
    ...(load === undefined ? [] : [`Host load ${load.toFixed(1)}×`]),
    ...(capacity?.startingBoxes ? [`Starting ${capacity.startingBoxes}/${capacity.startupLimit ?? '?'} boxes`] : []),
  ]
  if (!labels.length) return null
  const details = [
    'Squads share host CPUs. Per-box CPU and memory limits constrain usage; box counts do not reserve CPUs.',
    ...(load === undefined
      ? []
      : ['Host load is the 1-minute load average divided by host CPUs; it includes other boxes.']),
    ...(pressure && pressure.memTotalMb > 0 && Number.isFinite(pressure.memAvailableMb)
      ? [`Host memory ${Math.round(100 * (1 - pressure.memAvailableMb / pressure.memTotalMb))}% used.`]
      : []),
    ...(capacity?.startingBoxes
      ? ['Physical startup work is bounded; running boxes do not occupy startup slots.']
      : []),
  ]
  return (
    <span className="border-l border-th-border pl-1.5 text-secondary" title={details.join(' ')}>
      {labels.join(' · ')}
    </span>
  )
}
