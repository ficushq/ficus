import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import type postgres from 'postgres'
import { createPostgresConnection, getConnectionString } from '../db/connection'
import { HOME_PATH_COLUMNS, homePathColumnKey } from '../db/home-path-columns'
import { parseRebaseHomeArgs, rebaseHomePaths, RebaseHomeUsageError, validateRebasePaths } from './rebase-home'

// Neutral fixture HOMEs under a per-run root, so nothing else in the shared test database matches.
// The old HOME has a dot in it (like the real one), which the free-text pattern must treat literally.
const ROOT = `/srv/p5t9-${crypto.randomUUID().slice(0, 8)}`
const OLD = `${ROOT}/h/.old`
const NEW = `${ROOT}/h/.new`
const TYPE_ID = `rebase-home-${crypto.randomUUID()}`
const PAST = '2026-01-02 03:04:05.678'

let sql: postgres.Sql
const ids = {
  squad: '',
  agent: '',
  inbox: '',
  workStream: '',
  attachments: [] as string[],
  messages: [] as string[],
}

/**
 * A messages.metadata document shaped like the rows the P5-T0 audit found (`/root/<legacy>/…` inside
 * tool arguments and results, text and thinking blocks). `home` is spliced in where a HOME path
 * stands on its own; the `untouched` strings are look-alikes that must never change.
 */
function messageMetadata(home: string) {
  const untouched = [
    `${OLD}-lab/inbox-attachments/x`, // a different directory that shares the prefix
    `${OLD}er/x`, // ditto, without a separator
    `${OLD}.d/x`, // a dotted sibling
    `/mnt${OLD}/x`, // the same path under another root
    `${ROOT}/h/Xold/x`, // what an unescaped `.` would match
  ].join(' ')
  return {
    executionId: `exec-${ROOT}`,
    streamGroupId: 'group-1',
    content: [
      { type: 'thinking', id: 't1', content: `The attachment is under ${home}/inbox-attachments. ${untouched}` },
      {
        type: 'tool_use',
        id: 'u1',
        toolCall: {
          toolCallId: 'c1',
          toolName: 'read',
          args: JSON.stringify({ path: `${home}/inbox-attachments/m1/a1`, note: untouched }),
          result: `line one\n${home}/private/sb/file.txt\n${home}\n`,
          isError: false,
        },
      },
      {
        type: 'tool_use',
        id: 'u2',
        toolCall: {
          toolCallId: 'c2',
          toolName: 'bash',
          args: JSON.stringify({ command: `ls ${home} && cat "${home}/memory/notes.md"` }),
          result: JSON.stringify({ stdout: `${home}/memory\n${home}/logs`, cwd: home }),
          isError: false,
        },
      },
      { type: 'text', id: 'x1', content: `Saved to \`${home}/workspaces/squads/s1/report.md\`. See ${home}.` },
      {
        type: 'text',
        id: 'x2',
        content: `Open file://${home}/workspaces/squads/s1/index.html (not sftp://host${OLD}/x).`,
      },
    ],
  }
}

function ownership(home: string) {
  return {
    workspace: `${home}/workspaces/squads/s1`,
    repository: `${home}/workspaces/squads/s1/repo`,
    commonDirectory: `${home}/workspaces/squads/s1/repo/.git`,
    gitDirectory: `${home}/workspaces/squads/s1/repo/.git/worktrees/w1`,
    worktree: `${home}/workspaces/squads/s1/worktrees/w1`,
    directoryIdentity: '2049:1234',
    branch: 'work/w1',
  }
}

async function snapshot() {
  const [attachments, messages, squad, worktree, cleanup, workStream] = await Promise.all([
    sql`SELECT id, storage_path FROM inbox_attachments WHERE id = ANY(${ids.attachments}) ORDER BY storage_path`,
    sql`SELECT id, metadata FROM messages WHERE id = ANY(${ids.messages}) ORDER BY array_position(${ids.messages}::uuid[], id)`,
    sql`SELECT host_workspace_path, updated_at FROM squads WHERE id = ${ids.squad}`,
    sql`SELECT ownership FROM work_stream_worktrees WHERE work_stream_id = ${ids.workStream}`,
    sql`SELECT removal_input, updated_at FROM worktree_cleanup_jobs WHERE work_stream_id = ${ids.workStream}`,
    sql`SELECT metadata, files, updated_at FROM work_streams WHERE id = ${ids.workStream}`,
  ])
  return {
    attachments,
    messages,
    squad: squad[0],
    worktree: worktree[0],
    cleanup: cleanup[0],
    workStream: workStream[0],
  }
}

async function seed() {
  await cleanup()
  const [squad] = await sql`
    INSERT INTO squads (name, purpose, host_workspace_path, updated_at)
    VALUES (${`rebase-home-${ROOT}`}, 'rebase-home fixture', ${`${OLD}/workspaces/custom`}, ${PAST})
    RETURNING id`
  ids.squad = squad!.id
  const [agent] = await sql`INSERT INTO agents (agent_type_id, squad_id) VALUES (${TYPE_ID}, ${ids.squad}) RETURNING id`
  ids.agent = agent!.id
  const [inbox] = await sql`
    INSERT INTO inbox (recipient_type, recipient_id, sender_type, content)
    VALUES ('agent', ${ids.agent}, 'system', 'rebase-home fixture') RETURNING id`
  ids.inbox = inbox!.id
  ids.attachments = []
  for (const storagePath of [
    `${OLD}/inbox-attachments/m1/a1`,
    `${OLD}/inbox-attachments/m1/a2`,
    OLD,
    `${ROOT}/h/.older/inbox-attachments/m1/a3`,
    `${OLD}-lab/inbox-attachments/m1/a4`,
  ]) {
    const [row] = await sql`
      INSERT INTO inbox_attachments (message_id, filename, content_type, byte_size, sha256, storage_path)
      VALUES (${ids.inbox}, 'a.txt', 'text/plain', 1, ${'0'.repeat(64)}, ${storagePath}) RETURNING id`
    ids.attachments.push(row!.id)
  }
  ids.messages = []
  // Three with HOME paths (more than a batch of 2), one with only look-alikes, one without metadata.
  const documents = [
    messageMetadata(OLD),
    messageMetadata(OLD),
    messageMetadata(OLD),
    messageMetadata(`/mnt${OLD}`),
    null,
  ]
  for (const metadata of documents) {
    const [row] = await sql`
      INSERT INTO messages (agent_id, role, content, metadata)
      VALUES (${ids.agent}, 'assistant', 'fixture', ${metadata === null ? null : sql.json(metadata)}) RETURNING id`
    ids.messages.push(row!.id)
  }
  const [workStream] = await sql`
    INSERT INTO work_streams (squad_id, title, metadata, files, updated_at)
    VALUES (${ids.squad}, 'rebase-home fixture',
      ${sql.json({ git: { repository: `${OLD}/workspaces/squads/s1/repo`, worktree: `${OLD}/workspaces/squads/s1/worktrees/w1`, remote: 'origin' }, other: `${OLD}/kept-in-free-metadata` })},
      ${sql.json([`${OLD}/workspaces/squads/s1/a.txt`, 'relative/b.txt'])}, ${PAST})
    RETURNING id`
  ids.workStream = workStream!.id
  await sql`
    INSERT INTO work_stream_worktrees (work_stream_id, squad_id, ownership)
    VALUES (${ids.workStream}, ${ids.squad}, ${sql.json(ownership(OLD))})`
  await sql`
    INSERT INTO worktree_cleanup_jobs (work_stream_id, removal_input, updated_at)
    VALUES (${ids.workStream}, ${sql.json({ ownership: ownership(OLD), head: 'abc', operationId: 'op-1' })}, ${PAST})`
}

async function cleanup() {
  await sql`DELETE FROM squads WHERE name = ${`rebase-home-${ROOT}`}`
  await sql`DELETE FROM inbox WHERE content = 'rebase-home fixture' AND recipient_id = ${ids.agent || ''}`
  await sql`DELETE FROM agents WHERE agent_type_id = ${TYPE_ID}`
}

const zeros = () => Object.fromEntries(HOME_PATH_COLUMNS.map((entry) => [homePathColumnKey(entry), 0]))
const expectedCounts = () => ({
  ...zeros(),
  'inbox_attachments.storage_path': 3,
  'squads.host_workspace_path': 1,
  'work_stream_worktrees.ownership.workspace': 1,
  'work_stream_worktrees.ownership.repository': 1,
  'work_stream_worktrees.ownership.commonDirectory': 1,
  'work_stream_worktrees.ownership.gitDirectory': 1,
  'work_stream_worktrees.ownership.worktree': 1,
  'worktree_cleanup_jobs.removal_input.ownership.workspace': 1,
  'worktree_cleanup_jobs.removal_input.ownership.repository': 1,
  'worktree_cleanup_jobs.removal_input.ownership.commonDirectory': 1,
  'worktree_cleanup_jobs.removal_input.ownership.gitDirectory': 1,
  'worktree_cleanup_jobs.removal_input.ownership.worktree': 1,
  'work_streams.metadata.git.repository': 1,
  'work_streams.metadata.git.worktree': 1,
  'work_streams.files': 1,
  'messages.metadata': 3,
})

beforeAll(() => {
  sql = createPostgresConnection(getConnectionString(), { max: 2, onnotice: () => {} })
})

afterAll(async () => {
  await cleanup()
  await sql.end()
})

describe('rebaseHomePaths', () => {
  beforeEach(seed)

  it('rebases every registered path under the old HOME, and only those', async () => {
    const before = await snapshot()
    const counts = await rebaseHomePaths(sql, OLD, NEW)
    expect(counts).toEqual(expectedCounts())
    const after = await snapshot()

    expect(after.attachments.map((row) => row.storage_path).sort()).toEqual(
      [
        `${NEW}/inbox-attachments/m1/a1`,
        `${NEW}/inbox-attachments/m1/a2`,
        NEW,
        `${ROOT}/h/.older/inbox-attachments/m1/a3`, // prefix boundary: untouched
        `${OLD}-lab/inbox-attachments/m1/a4`, // ditto
      ].sort()
    )
    // The audit's shape: every HOME path in thinking, tool arguments (JSON in a string), multi-line
    // tool output and prose moves; the look-alikes and the other message stay byte for byte.
    expect(after.messages.map((row) => row.metadata)).toEqual([
      messageMetadata(NEW),
      messageMetadata(NEW),
      messageMetadata(NEW),
      messageMetadata(`/mnt${OLD}`),
      null,
    ])
    expect(after.squad!.host_workspace_path).toBe(`${NEW}/workspaces/custom`)
    expect(after.worktree!.ownership).toEqual(ownership(NEW))
    expect(after.cleanup!.removal_input).toEqual({ ownership: ownership(NEW), head: 'abc', operationId: 'op-1' })
    expect(after.workStream!.metadata).toEqual({
      git: {
        repository: `${NEW}/workspaces/squads/s1/repo`,
        worktree: `${NEW}/workspaces/squads/s1/worktrees/w1`,
        remote: 'origin',
      },
      other: `${OLD}/kept-in-free-metadata`, // only the registered keys of a free-form document
    })
    expect(after.workStream!.files).toEqual([`${NEW}/workspaces/squads/s1/a.txt`, 'relative/b.txt'])
    // A relocation, not an edit: no updated_at moves.
    expect(after.squad!.updated_at).toEqual(before.squad!.updated_at)
    expect(after.cleanup!.updated_at).toEqual(before.cleanup!.updated_at)
    expect(after.workStream!.updated_at).toEqual(before.workStream!.updated_at)
    expect(new Date(before.squad!.updated_at).getUTCFullYear()).toBe(2026)
  })

  it('is idempotent: a second run changes nothing and reports all zeros', async () => {
    await rebaseHomePaths(sql, OLD, NEW)
    const once = await snapshot()
    expect(await rebaseHomePaths(sql, OLD, NEW)).toEqual(zeros())
    expect(await snapshot()).toEqual(once)
  })

  it('--dry-run reports the same counts and writes nothing', async () => {
    const before = await snapshot()
    expect(await rebaseHomePaths(sql, OLD, NEW, { dryRun: true })).toEqual(expectedCounts())
    expect(await snapshot()).toEqual(before)
  })

  it('walks the rows in batches with the same result', async () => {
    const counts = await rebaseHomePaths(sql, OLD, NEW, { batchSize: 1 })
    expect(counts).toEqual(expectedCounts())
    const batched = await snapshot()
    await seed()
    await rebaseHomePaths(sql, OLD, NEW)
    const whole = await snapshot()
    expect(batched.messages.map((row) => row.metadata)).toEqual(whole.messages.map((row) => row.metadata))
    expect(batched.attachments.map((row) => row.storage_path).sort()).toEqual(
      whole.attachments.map((row) => row.storage_path).sort()
    )
  })

  it('reverses exactly: rebasing back restores every row byte for byte (the migration inverse)', async () => {
    const original = await snapshot()
    await rebaseHomePaths(sql, OLD, NEW)
    expect(await rebaseHomePaths(sql, NEW, OLD)).toEqual(expectedCounts())
    expect(await snapshot()).toEqual(original)
  })

  it('runs in one transaction: a failure part way leaves every column as it was', async () => {
    const before = await snapshot()
    let statements = 0
    const failing = {
      begin: (callback: (tx: postgres.TransactionSql) => Promise<unknown>) =>
        sql.begin((tx) =>
          callback(
            new Proxy(tx, {
              get(target, property) {
                if (property !== 'unsafe') return Reflect.get(target, property)
                return (...args: Parameters<postgres.TransactionSql['unsafe']>) => {
                  // The lock, then one statement per column: fail after several columns were rewritten.
                  if (++statements === 10) throw new Error('injected failure')
                  return target.unsafe(...args)
                }
              },
            })
          )
        ),
    } as unknown as postgres.Sql
    await expect(rebaseHomePaths(failing, OLD, NEW)).rejects.toThrow('injected failure')
    expect(statements).toBe(10)
    expect(await snapshot()).toEqual(before)
  })
})

describe('rebase-home arguments', () => {
  it('accepts two different absolute, normalized paths', () => {
    expect(parseRebaseHomeArgs(['--from', OLD, '--to', NEW])).toEqual({ from: OLD, to: NEW, dryRun: false })
    expect(parseRebaseHomeArgs([`--from=${OLD}`, `--to=${NEW}`, '--dry-run'])).toEqual({
      from: OLD,
      to: NEW,
      dryRun: true,
    })
  })

  it('refuses anything else', () => {
    const refused = (argv: string[]) => expect(() => parseRebaseHomeArgs(argv)).toThrow(RebaseHomeUsageError)
    refused([])
    refused(['--from', OLD])
    refused(['--from', OLD, '--to'])
    refused(['--from', 'relative/home', '--to', NEW])
    refused(['--from', `${OLD}/`, '--to', NEW])
    refused(['--from', '/', '--to', NEW])
    refused(['--from', `${ROOT}//h`, '--to', NEW])
    refused(['--from', `${ROOT}/h/../x`, '--to', NEW])
    refused(['--from', OLD, '--to', OLD])
    refused(['--from', OLD, '--to', `${OLD}/nested`])
    refused(['--from', `${NEW}/nested`, '--to', NEW])
    refused(['--from', `${ROOT}/h/"q`, '--to', NEW])
    refused(['--from', `${ROOT}/h/back\\slash`, '--to', NEW])
    refused(['--from', OLD, '--to', NEW, '--force'])
    expect(() => validateRebasePaths(OLD, `${ROOT}/h/.new\n`)).toThrow(RebaseHomeUsageError)
  })
})
