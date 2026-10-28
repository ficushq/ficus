import type { GitHubFeedbackContent } from '@ficus/shared'
import { sql, type SQLWrapper } from 'drizzle-orm'
import type { integrationOutputEvents } from '../../../db'

type Event = typeof integrationOutputEvents.$inferSelect
const KINDS = ['issue', 'pull_request', 'issue_comment', 'review', 'review_comment', 'action']
const REPOSITORY_ID = '^[1-9][0-9]*$'
const NATIVE_ID = '^[1-9][0-9]*$'
const ACTION_ID = '^[1-9][0-9]*-[0-9a-f]{24}$'
const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
export const GITHUB_FRESHNESS_UNBOUND = 'github_freshness_unbound'

/** Shape of server-normalized native provenance, NOT trust/approval or a substitute for admission. */
export function hasGitHubFreshnessBinding(event: Pick<Event, 'integration' | 'sourceKey' | 'fact'>): boolean {
  if (event.integration !== 'github') return true
  if (event.sourceKey.startsWith('github-status:')) return true
  const github = event.fact.github
  if (
    event.sourceKey.startsWith('github-feedback:') &&
    typeof github?.revisionId === 'string' &&
    new RegExp(UUID).test(github.revisionId)
  )
    return true
  const identity = (content: GitHubFeedbackContent | null | undefined): content is GitHubFeedbackContent =>
    !!content &&
    typeof content.repositoryId === 'string' &&
    new RegExp(REPOSITORY_ID).test(content.repositoryId) &&
    typeof content.nativeId === 'string' &&
    new RegExp(content.objectKind === 'action' ? ACTION_ID : NATIVE_ID).test(content.nativeId)
  const content = github?.content
  const parent = github?.rawParent
  if (identity(content) && KINDS.includes(content.objectKind))
    return (
      content.objectKind !== 'action' || (identity(parent) && ['issue', 'pull_request'].includes(parent.objectKind))
    )
  if (content != null) return false
  const status = github?.status
  return (
    !!status &&
    status.data.projection === 'status' &&
    status.output === event.fact.output &&
    status.resourceKey === event.fact.resourceKey &&
    typeof status.data.repository === 'string' &&
    status.data.repository.length > 0 &&
    status.data.repository === event.fact.data.repository
  )
}

/** SQL counterpart for pure inbox list/search/count reads. Never materializes an unbound body. */
export function gitHubFreshnessBindingSQL(fact: SQLWrapper, sourceKey: SQLWrapper) {
  const identity = (key: 'content' | 'rawParent') => sql`(
    jsonb_typeof(${fact} #> ${`{github,${key},repositoryId}`}) = 'string'
    AND ${fact} #>> ${`{github,${key},repositoryId}`} ~ ${REPOSITORY_ID}
    AND jsonb_typeof(${fact} #> ${`{github,${key},nativeId}`}) = 'string'
    AND ${fact} #>> ${`{github,${key},nativeId}`} ~ (case when ${fact} #>> ${`{github,${key},objectKind}`} = 'action' then ${ACTION_ID} else ${NATIVE_ID} end)
  )`
  return sql`coalesce((
    ${sourceKey} LIKE 'github-status:%'
    OR (${sourceKey} LIKE 'github-feedback:%' AND ${fact} #>> '{github,revisionId}' ~ ${UUID})
    OR (${identity('content')} AND ${fact} #>> '{github,content,objectKind}' IN ('issue', 'pull_request', 'issue_comment', 'review', 'review_comment', 'action')
      AND (${fact} #>> '{github,content,objectKind}' <> 'action' OR
        (${identity('rawParent')} AND ${fact} #>> '{github,rawParent,objectKind}' IN ('issue', 'pull_request'))))
    OR ((${fact} #> '{github,content}' IS NULL OR ${fact} #> '{github,content}' = 'null'::jsonb)
      AND ${fact} #>> '{github,status,data,projection}' = 'status'
      AND ${fact} #>> '{github,status,output}' = ${fact} ->> 'output'
      AND ${fact} #>> '{github,status,resourceKey}' = ${fact} ->> 'resourceKey'
      AND nullif(${fact} #>> '{github,status,data,repository}', '') IS NOT NULL
      AND ${fact} #>> '{github,status,data,repository}' = ${fact} #>> '{data,repository}')
  ), false)`
}
