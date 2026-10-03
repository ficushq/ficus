import { lstatSync } from 'fs'

/** A previous bridge release may have left this journal during an interrupted rename. */
export const RENAME_JOURNAL = 'rename-identity.journal'

/** Never start or update a checkout whose earlier identity move may be incomplete. */
export function assertNoRenameInFlight(path: string): void {
  try {
    lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new Error('cannot inspect the retired identity-move journal; resolve access before managing this instance', {
      cause: error,
    })
  }
  throw new Error(
    'an earlier identity move is unfinished; resolve its journal with the ficus-host-layout-bridge release before managing this instance'
  )
}
