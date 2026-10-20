import { expect, test } from 'bun:test'
import { getTableConfig } from 'drizzle-orm/pg-core'
import {
  agentTypes,
  integrationAuditEvents,
  integrationAuthStateEnum,
  integrationConnectionAssignments,
  integrationConnections,
  integrationAuthorizationFlowReceipts,
  integrationCredentialCleanupJobs,
  integrationOauthStates,
  integrationProjectionStates,
  integrationRevocationJobs,
} from './schema'

test('integration persistence stores only opaque credential references', () => {
  const connectionColumns = getTableConfig(integrationConnections).columns.map((column) => column.name)
  expect(connectionColumns).toContain('credential_ref')
  expect(connectionColumns.some((name) => /token|plaintext|credential_value/.test(name))).toBe(false)
})

test('credential cleanup tombstones contain only opaque retry metadata', () => {
  const columns = getTableConfig(integrationCredentialCleanupJobs).columns.map((column) => column.name)
  expect(columns).toContain('credential_ref')
  expect(columns).toEqual(expect.arrayContaining(['attempts', 'next_attempt_at', 'lease_token', 'lease_expires_at']))
  expect(columns.some((name) => /encrypted|plaintext|credential_value|payload|token_value|error_text/.test(name))).toBe(
    false
  )
})

test('integration policy remains durable', () => {
  expect(getTableConfig(agentTypes).columns.map((column) => column.name)).toContain('integration_capabilities')
})

test('integration assignments are the provider-safe squad binding', () => {
  const assignment = getTableConfig(integrationConnectionAssignments)
  expect(assignment.primaryKeys[0]!.columns.map((column) => column.name)).toEqual([
    'squad_id',
    'provider_key',
    'connection_id',
  ])
  expect(
    assignment.foreignKeys.some(
      (foreignKey) =>
        foreignKey
          .reference()
          .columns.map((column) => column.name)
          .join() === 'connection_id,provider_key'
    )
  ).toBe(true)
  expect(
    assignment.indexes.some((index) => index.config.name === 'idx_integration_connection_assignments_connection')
  ).toBe(true)
})

test('legacy ownership and global lifecycle audit squad attribution are optional', () => {
  expect(getTableConfig(integrationConnections).columns.find((column) => column.name === 'squad_id')?.notNull).toBe(
    false
  )
  expect(getTableConfig(integrationAuditEvents).columns.find((column) => column.name === 'squad_id')?.notNull).toBe(
    false
  )
})

test('hosted oauth authority and flow identity are durable', () => {
  const connection = getTableConfig(integrationConnections)
  expect(connection.columns.find((column) => column.name === 'client_authority')?.notNull).toBe(true)
  expect(connection.columns.map((column) => column.name)).toContain('authorization_flow_id')
  expect(connection.checks.map((entry) => entry.name)).toContain('integration_connections_client_authority_check')
  expect(connection.indexes.map((entry) => entry.config.name)).toContain(
    'uq_integration_connections_authorization_flow'
  )

  const oauthState = getTableConfig(integrationOauthStates)
  expect(oauthState.columns.map((column) => column.name)).toEqual(
    expect.arrayContaining(['local_flow_id', 'authority', 'completion_handle_hash', 'recovery_expires_at'])
  )
  expect(oauthState.checks.map((entry) => entry.name)).toEqual(
    expect.arrayContaining([
      'integration_oauth_states_authority_check',
      'integration_oauth_states_completion_claim_pair',
      'integration_oauth_states_completion_hash_format',
      'integration_oauth_states_authority_flow_check',
    ])
  )
})

test('authorization flow receipts are independent, token-free, and monotonic', () => {
  const receipt = getTableConfig(integrationAuthorizationFlowReceipts)
  expect(receipt.columns.map((column) => column.name)).toEqual(
    expect.arrayContaining([
      'local_flow_id',
      'provider_key',
      'authority',
      'intent',
      'initiating_user_id',
      'completion_handle_hash',
      'artifact_credential_ref',
      'staging_started_at',
      'install_kind',
      'installed_connection_id',
      'terminal_code',
      'revocation_required_at',
      'revocation_settled_at',
      'cleanup_required_at',
      'cleanup_settled_at',
      'recovery_expires_at',
      'retain_until',
    ])
  )
  expect(receipt.foreignKeys).toHaveLength(0)
  expect(receipt.checks.map((entry) => entry.name)).toEqual(
    expect.arrayContaining([
      'integration_auth_receipts_install_tuple',
      'integration_auth_receipts_install_terminal_exclusive',
      'integration_auth_receipts_obligation_disposition',
      'integration_auth_receipts_retention_window',
    ])
  )
  expect(receipt.columns.map((column) => column.name)).not.toEqual(
    expect.arrayContaining([
      'completion_handle',
      'provider_code',
      'token',
      'grant',
      'client_secret',
      'provider_body',
      'plaintext',
    ])
  )
})

test('oauth lifecycle jobs retain authority and restrict owned artifact deletion', () => {
  const revocation = getTableConfig(integrationRevocationJobs)
  expect(revocation.columns.map((column) => column.name)).toEqual(
    expect.arrayContaining(['client_authority', 'authorization_flow_id', 'terminal_at'])
  )
  expect(revocation.checks.map((entry) => entry.name)).toContain('integration_revocation_jobs_client_authority_check')

  const cleanup = getTableConfig(integrationCredentialCleanupJobs)
  expect(cleanup.columns.map((column) => column.name)).toContain('authorization_flow_id')
  expect(
    cleanup.foreignKeys.some((key) => {
      const reference = key.reference()
      return reference.columns.some((column) => column.name === 'credential_ref') && key.onDelete === 'restrict'
    })
  ).toBe(true)
})

test('oauth state is hashed, expiring, user-bound, and contains no authorization material', () => {
  expect(integrationAuthStateEnum.enumValues).toContain('reauthorization_required')
  const table = getTableConfig(integrationOauthStates)
  expect(table.primaryKeys).toHaveLength(0)
  expect(table.columns.find((column) => column.name === 'state_hash')?.primary).toBe(true)
  expect(table.indexes.some((index) => index.config.name === 'idx_integration_oauth_states_expiry')).toBe(true)
  expect(table.columns.map((column) => column.name)).toEqual(
    expect.arrayContaining([
      'provider_key',
      'user_id',
      'intent',
      'connection_id',
      'expected_material_revision',
      'redirect_uri',
      'return_to',
      'expires_at',
    ])
  )
  expect(
    table.columns.some((column) => /(^|_)(code|token|client_secret|provider_body|plaintext)($|_)/.test(column.name))
  ).toBe(false)
})

test('projection state is squad-owned, generation-fenced, and secret-free', () => {
  const table = getTableConfig(integrationProjectionStates)
  expect(table.primaryKeys[0]!.columns.map((column) => column.name)).toEqual(['squad_id', 'provider_key'])
  expect(table.columns.map((column) => column.name)).toEqual(
    expect.arrayContaining([
      'generation',
      'status',
      'desired_fingerprint',
      'applied_fingerprint',
      'desired_credential_revision',
      'applied_credential_revision',
      'attempts',
      'next_attempt_at',
      'lease_token',
      'lease_expires_at',
      'last_error_code',
    ])
  )
  expect(table.foreignKeys.some((key) => key.reference().foreignTable === integrationConnectionAssignments)).toBe(false)
  expect(table.checks.some((entry) => entry.name === 'integration_projection_states_lease_pair')).toBe(true)
  expect(
    table.columns.some((column) => /token_value|credential_ref|workspace|secret|payload|error_text/.test(column.name))
  ).toBe(false)
})

test('revocation jobs retain only an opaque restricted credential reference', () => {
  const table = getTableConfig(integrationRevocationJobs)
  expect(table.columns.map((column) => column.name)).toEqual(
    expect.arrayContaining(['provider_key', 'adapter_version', 'credential_ref', 'attempts', 'next_attempt_at'])
  )
  const credentialRef = table.columns.find((column) => column.name === 'credential_ref')
  expect(credentialRef?.isUnique).toBe(true)
  expect(credentialRef?.uniqueName).toBe('integration_revocation_jobs_credential_ref_unique')
  expect(
    table.foreignKeys.some((key) => {
      const reference = key.reference()
      return reference.columns.some((column) => column.name === 'credential_ref') && key.onDelete === 'restrict'
    })
  ).toBe(true)
  expect(table.columns.some((column) => /token_value|payload|provider_body|error_text/.test(column.name))).toBe(false)
})
