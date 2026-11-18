import { expect, test } from 'bun:test'
import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import { SLOT_COORDINATION_GUIDANCE } from '../../lib/prompts/slot-pools-prompt'

const root = join(import.meta.dir, '../../../../../')
const read = (path: string) => readFile(join(root, path), 'utf8')

test('the generated Slot Pools section defines the complete slot use protocol', () => {
  const rules = SLOT_COORDINATION_GUIDANCE.replace(/\s+/g, ' ')
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
    // Pools publish their own usage guidance in the same generated section.
    'The pools above and their usage guidance',
    // Disabled pools answer `disabled`: not enforced, nothing queued.
    'A `disabled` outcome',
    'not enforced right now',
  ]) {
    expect(rules).toContain(phrase)
  }
})

test('no static include carries the slot protocol, so squads without pools never read it', async () => {
  const dir = join(root, 'config/agent-types/shared')
  for (const file of await readdir(dir)) {
    expect({ file, slotClaim: (await readFile(join(dir, file), 'utf8')).includes('ficus slot claim') }).toEqual({
      file,
      slotClaim: false,
    })
  }
})

test('squad rules place the generated slot pools section right after squad context', async () => {
  const squadRules = await read('config/agent-types/shared/squad-rules.md')
  expect(squadRules).toContain('{{squad.context}}\n\n{{squad.slotPools}}')
})

test('manager and consultant share slot administration guidance', async () => {
  const [manager, consultant, guidance] = await Promise.all([
    read('config/agent-types/manager.yaml'),
    read('config/agent-types/consultant.yaml'),
    read('config/agent-types/shared/slot-manager.md'),
  ])
  expect(manager).toContain('- slot-manager')
  expect(consultant).toContain('- slot-manager')
  for (const command of [
    'ficus slot register',
    'ficus slot update',
    'ficus slot unregister',
    'ficus slot disable',
    'ficus slot enable',
    '--usage',
  ]) {
    expect(guidance).toContain(command)
  }
  const flattened = guidance.replace(/\s+/g, ' ')
  // Per-pool rules live in pool guidance, never hand-written squad context.
  expect(flattened).toContain('do not duplicate per-pool rules in squad context')
  expect(flattened).toContain("move it into that pool's guidance")
  expect(flattened).not.toContain('Add one short, actionable squad-context rule')
})

test('manager rejects manual authorization ceremony but permits approval-free platform slots', async () => {
  const manager = (await read('config/agent-types/manager.yaml')).replace(/\s+/g, ' ')
  expect(manager).toContain('Do not create manual tokens, nonces, lane-claim ledgers, per-command approvals')
  expect(manager).toContain('Platform-managed, approval-free `ficus slot` capacity admission is allowed')
  expect(manager).toContain("declared via a registered slot pool's usage guidance")
  expect(manager).not.toContain('squad context declares a protected resource')
  expect(manager).toContain('must not gain a duplicate manual ledger or approval gate')
})
