import { expect, test } from 'bun:test'
import { readFile } from 'fs/promises'
import { join } from 'path'

const root = join(import.meta.dir, '../../../../../')
const read = (path: string) => readFile(join(root, path), 'utf8')

test('shared agent guidance defines the complete slot use protocol', async () => {
  const rules = (await read('config/agent-types/shared/rules.md')).replace(/\s+/g, ' ')
  for (const phrase of [
    'ficus slot claim',
    // A blocked claim now queues on its own, so the protocol must say that
    // `queued` is not ownership rather than sending agents to `subscribe`.
    'queues you automatically',
    'not ownership',
    'end the turn',
    'grant wake',
    'Renew only',
    'release immediately',
    // Renew/release/unsubscribe take the id alone; guidance must not send
    // agents looking for a pool key or squad.
    'ficus slot release <claim-id>',
    'authoritative loss',
    'ficus slot list',
  ]) {
    expect(rules).toContain(phrase)
  }
})

test('manager and consultant share slot administration guidance', async () => {
  const [manager, consultant, guidance] = await Promise.all([
    read('config/agent-types/manager.yaml'),
    read('config/agent-types/consultant.yaml'),
    read('config/agent-types/shared/slot-manager.md'),
  ])
  expect(manager).toContain('- slot-manager')
  expect(consultant).toContain('- slot-manager')
  for (const command of ['ficus slot register', 'ficus slot update', 'ficus slot unregister']) {
    expect(guidance).toContain(command)
  }
  expect(guidance).toContain('Remove that rule when the pool is unregistered')
})

test('manager rejects manual authorization ceremony but permits approval-free platform slots', async () => {
  const manager = (await read('config/agent-types/manager.yaml')).replace(/\s+/g, ' ')
  expect(manager).toContain('Do not create manual tokens, nonces, lane-claim ledgers, per-command approvals')
  expect(manager).toContain('Platform-managed, approval-free `ficus slot` capacity admission is allowed')
  expect(manager).toContain('must not gain a duplicate manual ledger or approval gate')
})
