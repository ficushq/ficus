/** Sandbox pre-warming through the same readiness gate used by live sessions. */

import { createLogger } from '../../lib/infra/logger'
import { ensureSquadSandbox } from './ensure'

const log = createLogger('sandbox-prewarm')

export async function prewarmSandbox(
  squadId: string,
  ensure: (squadId: string) => Promise<string> = ensureSquadSandbox
): Promise<void> {
  log.info(`Pre-warming sandbox for squad ${squadId}...`)
  try {
    await ensure(squadId)
    log.info(`Sandbox pre-warmed for squad ${squadId}`)
  } catch (error) {
    log.error(`Failed to pre-warm sandbox for squad ${squadId}:`, error)
  }
}

export function prewarmSandboxBackground(squadId: string): void {
  if (process.env.FICUS_TEST_MODE === '1') return
  prewarmSandbox(squadId).catch((error) => {
    log.error(`Background sandbox prewarm failed for squad ${squadId}:`, error)
  })
}
