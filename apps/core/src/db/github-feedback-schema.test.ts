import { expect, test } from 'bun:test'
import { getTableConfig } from 'drizzle-orm/pg-core'
import * as schema from './schema'

const tables = {
  githubPersonalIdentities: schema.githubPersonalIdentities,
  githubTrustedAuthors: schema.githubTrustedAuthors,
  githubFeedbackObjects: schema.githubFeedbackObjects,
  githubFeedbackRevisions: schema.githubFeedbackRevisions,
  githubFeedbackSources: schema.githubFeedbackSources,
  githubFeedbackDecisions: schema.githubFeedbackDecisions,
}

test('personal GitHub identity storage is token-free with active ownership uniqueness', () => {
  expect(tables.githubPersonalIdentities).toBeDefined()
  const config = getTableConfig(tables.githubPersonalIdentities)
  expect(config.columns.map((column) => column.name)).toEqual(
    expect.arrayContaining(['user_id', 'account_id', 'generation', 'unlinked_at'])
  )
  expect(config.columns.some((column) => /token|credential|secret/.test(column.name))).toBe(false)
  expect(config.indexes.map((index) => index.config.name)).toContain('github_personal_identity_active_account')
  expect(config.checks.map((check) => check.name)).toEqual(
    expect.arrayContaining([
      'github_personal_identity_account_id',
      'github_personal_identity_generation',
      'github_personal_identity_host',
    ])
  )
})

test('manual trust has separate squad authority and provider identity checks', () => {
  expect(tables.githubTrustedAuthors).toBeDefined()
  const config = getTableConfig(tables.githubTrustedAuthors)
  expect(config.primaryKeys[0]!.columns.map((column) => column.name)).toEqual(['squad_id', 'host', 'account_id'])
  expect(config.checks.map((check) => check.name)).toEqual(
    expect.arrayContaining([
      'github_trusted_author_account_id',
      'github_trusted_author_type',
      'github_trusted_author_host',
    ])
  )
})

test('feedback snapshots, associations, and decision tombstones are durable and indexed separately from routing', () => {
  for (const name of [
    'githubFeedbackObjects',
    'githubFeedbackRevisions',
    'githubFeedbackSources',
    'githubFeedbackDecisions',
  ] as const) {
    expect(tables[name]).toBeDefined()
  }
  const revision = getTableConfig(tables.githubFeedbackRevisions)
  expect(revision.columns.map((column) => column.name)).toEqual(
    expect.arrayContaining(['content_hash', 'envelope', 'decision_version', 'release_state', 'next_attempt_at'])
  )
  expect(revision.indexes.map((index) => index.config.name)).toContain('github_feedback_revision_release')
  expect(revision.checks.map((check) => check.name)).toEqual(
    expect.arrayContaining([
      'github_feedback_revision_hash',
      'github_feedback_revision_decision',
      'github_feedback_revision_release_state',
    ])
  )
  // PostgreSQL shares a namespace for named constraints on each table.
  for (const name of ['githubFeedbackObjects', 'githubFeedbackRevisions'] as const) {
    const config = getTableConfig(tables[name])
    const names = [
      ...config.checks.map((entry) => entry.name),
      ...config.uniqueConstraints.map((entry) => entry.getName()),
    ]
    expect(new Set(names).size).toBe(names.length)
  }
  // Audit actor identifiers survive user removal; settled content can be pruned without losing hashes.
  expect(getTableConfig(tables.githubFeedbackDecisions).foreignKeys).toHaveLength(0)
})

test('OAuth state and recovery receipt retain personal purpose and unlink generation separately from connections', () => {
  for (const table of [schema.integrationOauthStates, schema.integrationAuthorizationFlowReceipts]) {
    const config = getTableConfig(table)
    expect(config.columns.map((column) => column.name)).toEqual(expect.arrayContaining(['purpose', 'link_generation']))
    expect(config.checks.some((check) => check.name.endsWith('_purpose_context'))).toBe(true)
  }
})

test('personal proof storage fences first-link and delayed-callback generations without retaining tokens', () => {
  const identity = getTableConfig(schema.githubPersonalIdentities)
  expect(identity.columns.find((column) => column.name === 'account_id')!.notNull).toBe(false)
  const table = schema.githubIdentityProofs
  expect(table).toBeDefined()
  const proof = getTableConfig(table)
  expect(proof.columns.map((column) => column.name)).toEqual(
    expect.arrayContaining(['flow_key', 'generation', 'consumed_at', 'expires_at', 'account_id'])
  )
  expect(proof.columns.some((column) => /token|credential|secret/.test(column.name))).toBe(false)
})

test('personal OAuth proof result has a separate receipt tuple rather than a fake integration connection', () => {
  const receipt = getTableConfig(schema.integrationAuthorizationFlowReceipts)
  expect(receipt.columns.map((column) => column.name)).toEqual(
    expect.arrayContaining(['identity_proof_id', 'identity_verified_at'])
  )
  expect(receipt.checks.map((check) => check.name)).toContain('integration_auth_receipts_identity_result')
})
