import { Command } from 'commander'
import { apiPost } from '../client'
import { output, outputTable, outputError, isJsonMode, isQuietMode } from '../output'

type NixGcVerdict = 'orphaned' | 'terminated' | 'live'

interface NixGcCandidate {
  sandboxId: string
  bytes: number
  verdict: NixGcVerdict
  running: boolean
}

interface NixGcScan {
  candidates: NixGcCandidate[]
  totalReclaimableBytes: number
}

interface NixGcApplyResult extends NixGcScan {
  reclaimed: string[]
  failed: string[]
}

interface WorkspaceGcResult {
  mode: 'dry-run' | 'apply'
  scanned: number
  eligible: number
  removed: number
  protected: Record<string, number>
  skipped: Record<string, number>
  errors: Record<string, number>
  hasMore: boolean
  nextCursor: string | null
}

interface WorkspaceGcOptions {
  apply?: boolean
  limit?: string
  cursor?: string
}

export function buildWorkspaceGcRequest(options: WorkspaceGcOptions): {
  apply?: true
  limit?: number
  cursor?: string
} {
  const request: { apply?: true; limit?: number; cursor?: string } = {}
  if (options.apply) request.apply = true
  if (options.limit !== undefined) {
    const limit = Number(options.limit)
    if (!Number.isInteger(limit)) throw new Error('Workspace GC limit must be an integer')
    request.limit = limit
  }
  if (options.cursor !== undefined) request.cursor = options.cursor
  return request
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(1)} ${units[unit]}`
}

export function registerAdminCommands(program: Command) {
  const admin = program.command('admin').description('Operator/admin maintenance actions')

  // ficus admin nix-gc [--apply]
  admin
    .command('nix-gc')
    .description('Reclaim orphaned/terminated agent Nix stores; dry-run by default (--apply reclaims)')
    .option('--apply', 'Reclaim eligible stores (default is a dry run: scan + report only)')
    .action(async (options) => {
      try {
        const body = options.apply ? { apply: true } : {}
        const result = await apiPost<NixGcScan | NixGcApplyResult>('/api/admin/nix-gc', body)
        if (isJsonMode()) {
          output(result)
          return
        }
        if (isQuietMode()) return

        const candidates = result.candidates ?? []
        if (candidates.length === 0) {
          console.log('No agent Nix stores found')
        } else {
          const rows = candidates.map((c) => ({
            sandboxId: c.sandboxId,
            size: formatBytes(c.bytes),
            verdict: c.running ? `${c.verdict} (running)` : c.verdict,
          }))
          outputTable(rows, ['sandboxId', 'size', 'verdict'])
        }

        const reclaimable = candidates.filter((c) => c.verdict !== 'live' && !c.running).length
        console.log(
          `${candidates.length} store(s), ${reclaimable} reclaimable ` +
            `(${formatBytes(result.totalReclaimableBytes)})`
        )

        if (options.apply) {
          const applied = result as NixGcApplyResult
          console.log(`Reclaimed ${applied.reclaimed.length}, failed ${applied.failed.length}`)
          if (applied.failed.length > 0) console.log(`Failed: ${applied.failed.join(', ')}`)
        } else {
          console.log('Dry run: re-run with --apply to reclaim')
        }
      } catch (error) {
        outputError(error as Error)
      }
    })

  admin
    .command('workspace-gc')
    .description('Remove empty orphan squad workspace roots; dry-run by default')
    .option('--apply', 'Remove eligible empty roots')
    .option('--limit <n>', 'Maximum immediate children to scan (1-5000)')
    .option('--cursor <cursor>', 'Opaque cursor returned by the previous page')
    .action(async (options: WorkspaceGcOptions) => {
      try {
        const body = buildWorkspaceGcRequest(options)
        const result = await apiPost<WorkspaceGcResult>('/api/admin/workspace-gc', body)
        if (isJsonMode()) {
          output(result)
          return
        }
        if (isQuietMode()) return

        console.log(result.mode === 'apply' ? 'Apply' : 'Dry run')
        console.log(`Scanned ${result.scanned}, eligible ${result.eligible}, removed ${result.removed}`)
        if (Object.keys(result.protected).length > 0) console.log(`Protected: ${JSON.stringify(result.protected)}`)
        if (Object.keys(result.skipped).length > 0) console.log(`Skipped: ${JSON.stringify(result.skipped)}`)
        if (Object.keys(result.errors).length > 0) console.log(`Errors: ${JSON.stringify(result.errors)}`)
        if (result.hasMore && result.nextCursor) {
          const continuation = ['ficus admin workspace-gc']
          if (options.apply) continuation.push('--apply')
          if (options.limit) continuation.push(`--limit ${options.limit}`)
          continuation.push(`--cursor ${result.nextCursor}`)
          console.log(`More entries remain. Continue with: ${continuation.join(' ')}`)
        }
      } catch (error) {
        outputError(error as Error)
      }
    })
}
