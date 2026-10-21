import type { ManagedBigbrainMemberAccess } from '../../api/integrations'

/** How a member's access reads in the settings card (upstream `read`, or `read` + `write`). */
export const ACCESS_LABEL: Record<ManagedBigbrainMemberAccess | 'none', string> = {
  read: 'Read',
  write: 'Read and write',
  none: 'No access',
}
