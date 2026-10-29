import { withGitHubRepositoryCache } from '../sources/GitHubIssueSource'
import type { MemorySourceType } from '@ficus/shared'
import { SquadSourceConfig } from '../../../entities/SquadSourceConfig'
import { createLogger } from '../../../lib/infra/logger'
import { reindexPendingGitHubMemory } from '../../integrations/github/managed-reindex'
import { IndexingService } from './IndexingService'

const log = createLogger('external-source-reindex')

export const EXTERNAL_INDEXED_SOURCE_TYPES = ['slack_thread', 'slack_canvas', 'github_issue'] as const
export type ExternalIndexedSourceType = (typeof EXTERNAL_INDEXED_SOURCE_TYPES)[number]

export interface ExternalSourceReindexSummary {
  indexed: number
  skipped: number
  failed: number
  disabled: boolean
  errors: string[]
}

export type ExternalReindexReport = Partial<Record<ExternalIndexedSourceType, ExternalSourceReindexSummary>>

export interface ExternalSourceReindexOptions {
  sourceTypes?: ExternalIndexedSourceType[]
}

export class ExternalSourceReindexService {
  private static _instance: ExternalSourceReindexService | null = null

  static instance(): ExternalSourceReindexService {
    if (!ExternalSourceReindexService._instance) {
      ExternalSourceReindexService._instance = new ExternalSourceReindexService()
    }
    return ExternalSourceReindexService._instance
  }

  static _reset(): void {
    ExternalSourceReindexService._instance = null
  }

  async reindexSquad(squadId: string, opts: ExternalSourceReindexOptions = {}): Promise<ExternalReindexReport> {
    const sourceTypes = opts.sourceTypes ?? [...EXTERNAL_INDEXED_SOURCE_TYPES]
    const report = {} as ExternalReindexReport

    for (const sourceType of sourceTypes) {
      report[sourceType] = await (sourceType === 'github_issue'
        ? withGitHubRepositoryCache(() => this.reindexSource(squadId, sourceType))
        : this.reindexSource(squadId, sourceType))
    }

    return report
  }

  private async reindexSource(
    squadId: string,
    sourceType: ExternalIndexedSourceType
  ): Promise<ExternalSourceReindexSummary> {
    const summary: ExternalSourceReindexSummary = {
      indexed: 0,
      skipped: 0,
      failed: 0,
      disabled: false,
      errors: [],
    }

    try {
      const config = await SquadSourceConfig.findBySquadAndType(squadId, sourceType)
      if (config?.enabled === false) {
        return { ...summary, skipped: 1, disabled: true }
      }

      const adapter = IndexingService.instance().getAdapter(sourceType as MemorySourceType)
      if (!adapter) {
        return { ...summary, failed: 1, errors: [`No adapter registered for ${sourceType}`] }
      }

      const pending = sourceType === 'github_issue' ? await reindexPendingGitHubMemory(squadId, adapter) : []
      const results = [...pending, ...(await adapter.indexAll(squadId))]
      for (const result of results) {
        if (result.skipped) summary.skipped++
        else if (result.success) summary.indexed++
        else {
          summary.failed++
          if (result.error) summary.errors.push(result.error)
        }
      }
      return summary
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn(`Failed to reindex ${sourceType} for squad ${squadId}: ${message}`)
      return { ...summary, failed: 1, errors: [message] }
    }
  }
}
