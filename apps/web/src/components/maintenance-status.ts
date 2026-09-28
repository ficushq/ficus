export function maintenanceControlDisabled(maintenanceAvailable: boolean, mutationPending: boolean): boolean {
  return !maintenanceAvailable || mutationPending
}

export function maintenanceStatusText(
  maintenance: { effective: boolean; phase: string } | undefined,
  loading: boolean,
  failed: boolean
): string {
  if (loading) return 'Loading maintenance state…'
  if (failed || !maintenance) return 'Maintenance state is unavailable. Ficus execution status is unknown.'
  if (!maintenance.effective) return 'Ficus is accepting agent work normally.'
  return maintenance.phase === 'pausing'
    ? 'Maintenance is starting and active turns are being safely interrupted.'
    : 'Ficus is paused. Submitted work is queued and resumes automatically.'
}
