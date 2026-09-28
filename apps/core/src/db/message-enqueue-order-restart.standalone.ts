import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findFreeTestDbPort } from '@ficus/shared/testDbPort'
import { MONOREPO_ROOT } from '../lib/paths'

const overlay = join(import.meta.dir, 'fixtures/message-enqueue-restart.compose.yml')
const mutation = process.env.FIFO_RESTART_MUTATION

function run(args: string[], env: Record<string, string>, input?: string): string {
  const result = Bun.spawnSync(args, {
    cwd: MONOREPO_ROOT,
    env: { ...process.env, ...env },
    stdin: input ? Buffer.from(input) : undefined,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) throw new Error(`${args.join(' ')} failed:\n${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

function compose(project: string, env: Record<string, string>, args: string[], input?: string) {
  return run(['docker', 'compose', '-p', project, '-f', overlay, ...args], env, input)
}

function psql(project: string, env: Record<string, string>, sql: string): string {
  return compose(
    project,
    env,
    ['exec', '-T', 'postgres', 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'fifo_restart', '-At'],
    sql
  )
}

async function waitReady(project: string, env: Record<string, string>) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      compose(project, env, [
        'exec',
        '-T',
        'postgres',
        'psql',
        '-U',
        'postgres',
        '-d',
        'fifo_restart',
        '-c',
        'SELECT 1',
      ])
      await Bun.sleep(500)
      compose(project, env, [
        'exec',
        '-T',
        'postgres',
        'psql',
        '-U',
        'postgres',
        '-d',
        'fifo_restart',
        '-c',
        'SELECT 1',
      ])
      return
    } catch {
      await Bun.sleep(250)
    }
  }
  throw new Error('persistent restart postgres did not become ready')
}

test('message enqueue sequence and rows survive a persistent-volume restart', async () => {
  const suffix = `${process.pid}-${crypto.randomUUID().slice(0, 8)}`
  const project = `tau-fifo-restart-${suffix}`
  const volume = `${project}-data`
  const env = { FIFO_RESTART_PORT: String(await findFreeTestDbPort()), FIFO_RESTART_VOLUME: volume }
  const cleanup = () => compose(project, env, ['down', '-v', '--remove-orphans'])
  try {
    compose(project, env, ['up', '-d'])
    await waitReady(project, env)
    psql(
      project,
      env,
      'CREATE TABLE messages (id uuid PRIMARY KEY, agent_id uuid NOT NULL, created_at timestamp NOT NULL DEFAULT now(), pending boolean NOT NULL DEFAULT false, injected_at timestamp);'
    )
    const journal = JSON.parse(readFileSync(join(MONOREPO_ROOT, 'apps/core/drizzle/meta/_journal.json'), 'utf8')) as {
      entries: Array<{ tag: string }>
    }
    const migrations = journal.entries
      .map(({ tag }) => readFileSync(join(MONOREPO_ROOT, `apps/core/drizzle/${tag}.sql`), 'utf8'))
      .filter((sql) => sql.includes('enqueue_order') && sql.includes('messages'))
    expect(migrations).toHaveLength(4)
    for (const migration of migrations) psql(project, env, migration.replaceAll('--> statement-breakpoint', ''))
    psql(project, env, 'INSERT INTO messages(id, agent_id) VALUES(gen_random_uuid(), gen_random_uuid());')
    const before = BigInt(psql(project, env, 'SELECT last_value FROM message_enqueue_order_seq;'))
    expect(psql(project, env, 'SELECT count(*) FROM messages;')).toBe('1')

    compose(project, env, ['restart', 'postgres'])
    await waitReady(project, env)
    if (mutation === 'reset-sequence') psql(project, env, 'ALTER SEQUENCE message_enqueue_order_seq RESTART WITH 1;')
    psql(project, env, 'INSERT INTO messages(id, agent_id) VALUES(gen_random_uuid(), gen_random_uuid());')
    const after = BigInt(psql(project, env, 'SELECT last_value FROM message_enqueue_order_seq;'))
    expect(psql(project, env, 'SELECT count(*) FROM messages;')).toBe('2')
    expect(after).toBeGreaterThan(before)

    cleanup()
    expect(run(['docker', 'volume', 'ls', '-q', '--filter', `name=^${volume}$`], env)).toBe('')
    compose(project, env, ['up', '-d'])
    await waitReady(project, env)
    expect(psql(project, env, `SELECT to_regclass('message_enqueue_order_seq') IS NULL;`)).toBe('t')
  } finally {
    try {
      cleanup()
    } catch {
      // Resource-specific assertions below report any cleanup leak precisely.
    }
    expect(run(['docker', 'ps', '-a', '-q', '--filter', `name=${project}`], env)).toBe('')
    expect(run(['docker', 'volume', 'ls', '-q', '--filter', `name=^${volume}$`], env)).toBe('')
    expect(run(['docker', 'network', 'ls', '-q', '--filter', `name=^${project}_default$`], env)).toBe('')
  }
}, 120_000)
