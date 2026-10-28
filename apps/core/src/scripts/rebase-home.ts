#!/usr/bin/env bun
/**
 * Rebase the absolute HOME_DIR paths Core stored in its database, bundled as `dist/rebase-home.js`:
 *
 *   bun dist/rebase-home.js --from <old HOME> --to <new HOME> [--dry-run [--structured-only]] [--force]
 *
 * The host layout migration (scripts/setup/lib.sh, `host_layout` S7b) runs it from the TARGET
 * release while the services are stopped, right after it moved HOME, the way artifact_activate runs
 * `dist/migrate.js`: every line of the install's `.env` exported, cwd `<release>/apps/core`. Its
 * inverse runs the same program with `--from` and `--to` swapped. So:
 *
 * - it connects with `DATABASE_URL` from the process environment and never reads a `.env` itself
 *   (exit 2 when it is not set);
 * - it rewrites every column in HOME_PATH_COLUMNS (db/home-path-columns.ts) in ONE transaction, in
 *   batches, and touches only the rows whose value changes (no `updated_at` is set);
 * - it is idempotent: a second run matches nothing and reports 0 for every column;
 * - it prints `REBASE_HOME <table>.<column>[.<json key>…]=<rows changed>` for every STRUCTURED
 *   column (kind `text` or `jsonb-string`), then `REBASE_HOME_TEXT <column key>=<rows changed>` for
 *   every free-text column (kind `jsonb-text`), and exits 0 even when every count is 0. A caller
 *   that must prove no stored path is left under `--from` (switch-run-user.sh S4) fails on
 *   `^REBASE_HOME [^=]+=[1-9]` and so ignores free-text mentions, which a live instance keeps
 *   writing (an agent quoting the old HOME in a message) and which never name a file Core opens;
 * - it refuses (exit 3, nothing written) when a STRUCTURED column (kind `text` or `jsonb-string`:
 *   the value is a path) already holds a path under `--to` while a structured column still holds
 *   one under `--from`: rewriting would merge the two, and the reverse run could no longer tell
 *   them apart. `--force` rewrites anyway. Free-text columns (kind `jsonb-text`: message content, a
 *   work stream's file list) never refuse, on either side: every standalone occurrence of a path in
 *   them is rewritten by design, so a mention of `--to` (agents discussing the new HOME) is the same
 *   thing as a stored path there and proves no earlier move. Since the rewrite is one transaction,
 *   only a structured hit on both sides means the data already holds both HOMEs;
 * - it reports its progress on stderr as it goes, and bounds every statement with a
 *   `statement_timeout` (default 10 minutes).
 *
 * `--dry-run` counts the rows it would change in a read-only transaction and writes nothing. It also
 * prints the rows already under `--to`, per column: `REBASE_HOME_TARGET <column key>=<n>` for every
 * structured column (the counts the refusal uses; a refusal prints them too), then
 * `REBASE_HOME_TARGET_TEXT <column key>=<n>` for every free-text column (reported, never refused
 * on). Callers that refuse on `^REBASE_HOME_TARGET [^=]+=[1-9]` (switch-run-user.sh P6) therefore
 * ignore free-text mentions.
 *
 * `--structured-only` (with `--dry-run` only: a real rebase always rewrites every column in its one
 * transaction) skips the free-text columns altogether and prints only `REBASE_HOME` and
 * `REBASE_HOME_TARGET` lines. Counting free text scans every row of `messages.metadata` (the
 * largest table, detoasted and cast to text) three times, which is the cost of a full dry run; a
 * check that cannot fail on free text has no reason to pay it.
 */
import type postgres from 'postgres'
import { is } from 'drizzle-orm'
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core'
import * as schema from '../db/schema'
import { HOME_PATH_COLUMNS, homePathColumnKey, type HomePathColumn } from '../db/home-path-columns'

export class RebaseHomeUsageError extends Error {}

/** The data already holds paths under `to` while there is something to move from `from`. */
export class RebaseHomeTargetPresentError extends Error {
  constructor(
    /** Structured columns only: the counts that refused. */
    readonly targetCounts: Record<string, number>,
    /** Free-text columns: reported, never refused on. */
    readonly textTargetCounts: Record<string, number>,
    readonly from: string,
    readonly to: string
  ) {
    const where = Object.entries(targetCounts)
      .filter(([, count]) => count > 0)
      .map(([key, count]) => `${key}=${count}`)
      .join(', ')
    super(
      `the data already holds paths under ${to} (${where}) while paths under ${from} remain to move — ` +
        `rewriting would merge the two and the reverse could not tell them apart; nothing was written ` +
        `(inspect them, or re-run with --force to rewrite anyway)`
    )
  }
}

export interface RebaseHomeOptions {
  dryRun?: boolean
  /** Dry run only: leave the free-text (`jsonb-text`) columns out — neither counted nor reported. */
  structuredOnly?: boolean
  /** Rewrite even when the data already holds paths under `to` (see RebaseHomeTargetPresentError). */
  force?: boolean
  /** Rows examined per statement (default 500). */
  batchSize?: number
  /** Per-statement timeout in milliseconds (default 10 minutes; 0 disables it). */
  statementTimeoutMs?: number
  /** Progress lines (stderr in the CLI). */
  onProgress?: (message: string) => void
}

export interface RebaseHomeResult {
  /** Rows changed (or, dry run, that would change) per column key (no free-text key when `structuredOnly`). */
  counts: Record<string, number>
  /** Rows already holding a path under `to`, per structured column key, before anything moved. */
  targetCounts: Record<string, number>
  /** The same for the free-text (`jsonb-text`) columns, which never refuse. */
  textTargetCounts: Record<string, number>
}

/** A free-text column: a mention of a path and a stored path are the same thing there. */
export function isFreeTextHomePathColumn(entry: HomePathColumn): boolean {
  return entry.kind === 'jsonb-text'
}

const DEFAULT_BATCH_SIZE = 500
const DEFAULT_STATEMENT_TIMEOUT_MS = 10 * 60 * 1000
const PROGRESS_EVERY_BATCHES = 20
const JSON_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/
// A path value embedded in SQL parameters and a JSON document: no quote, backslash or control
// character (they would need JSON or regexp-replacement escaping), no empty, `.` or `..` segment.
const hasUnsafePathCharacter = (value: string) =>
  [...value].some((char) => char === '"' || char === '\\' || char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)

/** Checks `--from` / `--to`; throws RebaseHomeUsageError with the reason. */
export function validateRebasePaths(from: string, to: string): void {
  for (const [flag, value] of [
    ['--from', from],
    ['--to', to],
  ] as const) {
    if (!value) throw new RebaseHomeUsageError(`${flag} is required`)
    if (!value.startsWith('/')) throw new RebaseHomeUsageError(`${flag} must be an absolute path: ${value}`)
    if (value === '/' || value.endsWith('/'))
      throw new RebaseHomeUsageError(`${flag} must not be / or end with /: ${value}`)
    if (
      value
        .slice(1)
        .split('/')
        .some((segment) => segment === '' || segment === '.' || segment === '..')
    )
      throw new RebaseHomeUsageError(`${flag} must be a normalized path (no empty, . or .. segment): ${value}`)
    if (hasUnsafePathCharacter(value))
      throw new RebaseHomeUsageError(`${flag} must not contain a quote, backslash or control character`)
  }
  if (from === to) throw new RebaseHomeUsageError('--from and --to are the same path')
  if (to.startsWith(`${from}/`) || from.startsWith(`${to}/`))
    throw new RebaseHomeUsageError('--from and --to must not contain one another')
}

/** A PostgreSQL (ARE) regex matching `value` literally. */
function areLiteral(value: string): string {
  return value.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&')
}

/**
 * The ARE pattern of an occurrence of `from` in free text that stands on its own: not preceded by a
 * path or name character (a `\n`, `\r` or `\t` escape — a line break inside JSON — and the `://` of
 * a `file:///…` URL count as a boundary), and not continued by a name character or a dot that
 * starts one. `FROM/…`, `FROM"`, `file://FROM` and `FROM.` at the end of a sentence are occurrences;
 * `FROMX`, `FROM-lab`, `FROM.d`, `/x/FROM` and `sftp://host/FROM` are not.
 */
export function homePathOccurrencePattern(from: string): string {
  return (
    String.raw`(?:(?<![[:alnum:]_.~/-])|(?<=\\[nrt])|(?<=://))` +
    areLiteral(from) +
    String.raw`(?![[:alnum:]_-]|\.[[:alnum:]_-])`
  )
}

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`

const tablesByName = new Map(
  Object.values(schema as Record<string, unknown>)
    .filter((value): value is PgTable => is(value, PgTable))
    .map((table) => [getTableConfig(table).name, table] as const)
)

/** A registry table's single-column primary key and its SQL type (the batches walk it in order). */
export function homePathTableKey(tableName: string): { column: string; sqlType: string } {
  const table = tablesByName.get(tableName)
  if (!table) throw new Error(`home-path-columns: no table ${tableName} in the schema`)
  const config = getTableConfig(table)
  const keys = config.columns.filter((column) => column.primary)
  if (keys.length !== 1 || config.primaryKeys.length > 0)
    throw new Error(`home-path-columns: ${tableName} needs a single-column primary key`)
  return { column: keys[0]!.name, sqlType: keys[0]!.getSQLType() }
}

/**
 * The SQL of one column: `candidate` selects rows that may hold a path under $1, `next` is the
 * rebased value (from $1 to $2; `jsonb-text` also uses $4, the occurrence pattern).
 */
function columnExpressions(entry: HomePathColumn): { candidate: string; next: string } {
  const c = `t.${ident(entry.column)}`
  const from = '$1::text'
  const to = '$2::text'
  const underFrom = (value: string) => `(${value} = ${from} OR left(${value}, length(${from}) + 1) = ${from} || '/')`
  const rebased = (value: string) => `${to} || substr(${value}, length(${from}) + 1)`
  switch (entry.kind) {
    case 'text':
      return { candidate: underFrom(c), next: rebased(c) }
    case 'jsonb-string': {
      const keys = entry.jsonPath ?? []
      if (keys.length === 0 || !keys.every((key) => JSON_KEY.test(key)))
        throw new Error(`home-path-columns: ${homePathColumnKey(entry)} needs a jsonPath of plain keys`)
      const path = `ARRAY[${keys.map((key) => `'${key}'`).join(', ')}]::text[]`
      const value = `(${c} #>> ${path})`
      return {
        candidate: `(jsonb_typeof(${c} #> ${path}) = 'string' AND ${underFrom(value)})`,
        next: `jsonb_set(${c}, ${path}, to_jsonb(${rebased(value)}))`,
      }
    }
    case 'jsonb-text':
      // The text form of a jsonb keeps `from` verbatim: it holds no character JSON escapes.
      return {
        candidate: `strpos(${c}::text, ${from}) > 0`,
        next: `regexp_replace(${c}::text, $4::text, ${to}, 'g')::jsonb`,
      }
  }
}

/** Rows of `entry` that hold a path under `path` (the same match the rewrite uses). */
async function countUnder(tx: postgres.TransactionSql, entry: HomePathColumn, path: string): Promise<number> {
  const table = ident(entry.table)
  const { candidate } = columnExpressions(entry)
  // $2 (the rewrite's target) is unused here; `jsonb-text` also needs the occurrence pattern ($4).
  const where = entry.kind === 'jsonb-text' ? `(${candidate}) AND t.${ident(entry.column)}::text ~ $4::text` : candidate
  const [row] = (await tx.unsafe(
    `SELECT count(*)::int AS n FROM ${table} t WHERE ($2::text IS NULL OR true) AND ($3::text IS NULL OR true) AND ${where}`,
    [path, null, null, ...(entry.kind === 'jsonb-text' ? [homePathOccurrencePattern(path)] : [])]
  )) as unknown as { n: number }[]
  return row!.n
}

async function rebaseColumn(
  tx: postgres.TransactionSql,
  entry: HomePathColumn,
  from: string,
  to: string,
  dryRun: boolean,
  batchSize: number,
  onProgress: (message: string) => void
): Promise<number> {
  const table = ident(entry.table)
  const column = ident(entry.column)
  const key = homePathTableKey(entry.table)
  const k = `t.${ident(key.column)}`
  const { candidate, next } = columnExpressions(entry)
  const batch = `SELECT ${k} AS k FROM ${table} t
      WHERE ($3::text IS NULL OR ${k} > ($3::text)::${key.sqlType}) AND ${candidate}
      ORDER BY ${k} LIMIT ${batchSize}`
  const changed = dryRun
    ? `SELECT 1 FROM ${table} t JOIN batch ON ${k} = batch.k WHERE (${next}) IS DISTINCT FROM t.${column}`
    : `UPDATE ${table} t SET ${column} = ${next} FROM batch
         WHERE ${k} = batch.k AND (${next}) IS DISTINCT FROM t.${column} RETURNING 1`
  const statement = `WITH batch AS (${batch}), changed AS (${changed})
    SELECT (SELECT k::text FROM batch ORDER BY k DESC LIMIT 1) AS last,
           (SELECT count(*) FROM batch)::int AS seen,
           (SELECT count(*) FROM changed)::int AS changed`
  const parameters = entry.kind === 'jsonb-text' ? [homePathOccurrencePattern(from)] : []
  let last: string | null = null
  let total = 0
  let batches = 0
  const started = Date.now()
  for (;;) {
    const [row] = (await tx.unsafe(statement, [from, to, last, ...parameters])) as unknown as {
      last: string | null
      seen: number
      changed: number
    }[]
    total += row!.changed
    batches += 1
    if (row!.seen < batchSize || row!.last === null) break
    last = row!.last
    if (batches % PROGRESS_EVERY_BATCHES === 0)
      onProgress(`${homePathColumnKey(entry)}: ${batches} batches, ${total} row(s) so far (${Date.now() - started} ms)`)
  }
  onProgress(`${homePathColumnKey(entry)}: ${total} row(s) in ${batches} batch(es), ${Date.now() - started} ms`)
  return total
}

/**
 * Rewrites every stored absolute path under `from` to the same path under `to`, in one transaction.
 * Returns the rows changed (or, with `dryRun`, that would change) per column key, and the rows that
 * already held a path under `to`. Throws RebaseHomeTargetPresentError — having written nothing —
 * when structured columns hold both, unless `force` (a dry run only reports them; free-text columns
 * never refuse).
 */
export async function rebaseHomePaths(
  sql: postgres.Sql,
  from: string,
  to: string,
  opts: RebaseHomeOptions = {}
): Promise<RebaseHomeResult> {
  validateRebasePaths(from, to)
  const dryRun = opts.dryRun ?? false
  const structuredOnly = opts.structuredOnly ?? false
  if (structuredOnly && !dryRun)
    throw new RebaseHomeUsageError('structuredOnly needs dryRun: a rebase rewrites every column in one transaction')
  const columns = structuredOnly
    ? HOME_PATH_COLUMNS.filter((entry) => !isFreeTextHomePathColumn(entry))
    : HOME_PATH_COLUMNS
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE
  if (!Number.isInteger(batchSize) || batchSize < 1)
    throw new RebaseHomeUsageError('batchSize must be a positive integer')
  const timeout = opts.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS
  if (!Number.isInteger(timeout) || timeout < 0)
    throw new RebaseHomeUsageError('statementTimeoutMs must be a non-negative integer')
  const onProgress = opts.onProgress ?? (() => {})
  const run = async (tx: postgres.TransactionSql) => {
    // One rebase at a time; a second waits and then finds nothing left to change.
    await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtext('ficus:rebase-home'))`)
    await tx.unsafe(`SET LOCAL statement_timeout = ${timeout}`)
    const targetCounts: Record<string, number> = {}
    const textTargetCounts: Record<string, number> = {}
    let targets = 0
    let sources = 0
    let textTargets = 0
    let textSources = 0
    for (const entry of columns) {
      const key = homePathColumnKey(entry)
      const target = await countUnder(tx, entry, to)
      const source = await countUnder(tx, entry, from)
      if (isFreeTextHomePathColumn(entry)) {
        textTargetCounts[key] = target
        textTargets += target
        textSources += source
      } else {
        targetCounts[key] = target
        targets += target
        sources += source
      }
    }
    onProgress(
      `${sources} structured row(s) hold paths under ${from}, ${targets} under ${to}; ` +
        (structuredOnly
          ? 'free text not counted (structured only)'
          : `free text: ${textSources} row(s) mention ${from}, ${textTargets} mention ${to}`)
    )
    if (!dryRun && !opts.force && targets > 0 && sources > 0)
      throw new RebaseHomeTargetPresentError(targetCounts, textTargetCounts, from, to)
    const counts: Record<string, number> = {}
    for (const entry of columns) {
      counts[homePathColumnKey(entry)] = await rebaseColumn(tx, entry, from, to, dryRun, batchSize, onProgress)
    }
    return { counts, targetCounts, textTargetCounts }
  }
  return (await (dryRun ? sql.begin('read only', run) : sql.begin(run))) as RebaseHomeResult
}

/** Parses the command line; throws RebaseHomeUsageError. */
export function parseRebaseHomeArgs(argv: string[]): {
  from: string
  to: string
  dryRun: boolean
  structuredOnly: boolean
  force: boolean
} {
  let from = ''
  let to = ''
  let dryRun = false
  let structuredOnly = false
  let force = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const [flag, inline] =
      arg.startsWith('--') && arg.includes('=')
        ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]
        : [arg, undefined]
    if (flag === '--dry-run' && inline === undefined) dryRun = true
    else if (flag === '--structured-only' && inline === undefined) structuredOnly = true
    else if (flag === '--force' && inline === undefined) force = true
    else if (flag === '--from' || flag === '--to') {
      const value = inline ?? argv[++i]
      if (value === undefined) throw new RebaseHomeUsageError(`${flag} needs a value`)
      if (flag === '--from') from = value
      else to = value
    } else throw new RebaseHomeUsageError(`unknown argument: ${arg}`)
  }
  validateRebasePaths(from, to)
  if (structuredOnly && !dryRun) throw new RebaseHomeUsageError('--structured-only needs --dry-run')
  return { from, to, dryRun, structuredOnly, force }
}

const FREE_TEXT_KEYS = new Set(HOME_PATH_COLUMNS.filter(isFreeTextHomePathColumn).map(homePathColumnKey))

/** `REBASE_HOME` lines for the structured columns, then `REBASE_HOME_TEXT` for free text. */
function printCounts(counts: Record<string, number>): void {
  const entries = Object.entries(counts)
  for (const [key, count] of entries) if (!FREE_TEXT_KEYS.has(key)) console.log(`REBASE_HOME ${key}=${count}`)
  for (const [key, count] of entries) if (FREE_TEXT_KEYS.has(key)) console.log(`REBASE_HOME_TEXT ${key}=${count}`)
}

/** `REBASE_HOME_TARGET` lines for the structured columns, then `REBASE_HOME_TARGET_TEXT` for free text. */
function printTargetCounts(targetCounts: Record<string, number>, textTargetCounts: Record<string, number>): void {
  for (const [key, count] of Object.entries(targetCounts)) console.log(`REBASE_HOME_TARGET ${key}=${count}`)
  for (const [key, count] of Object.entries(textTargetCounts)) console.log(`REBASE_HOME_TARGET_TEXT ${key}=${count}`)
}

const USAGE =
  'usage: bun dist/rebase-home.js --from <old HOME_DIR> --to <new HOME_DIR> [--dry-run [--structured-only]] [--force]'

export async function main(argv: string[], env: Record<string, string | undefined> = process.env): Promise<number> {
  let args
  try {
    args = parseRebaseHomeArgs(argv)
  } catch (error) {
    console.error(`rebase-home: ${(error as Error).message}\n${USAGE}`)
    return 2
  }
  const databaseUrl = env.DATABASE_URL
  if (!databaseUrl) {
    console.error('rebase-home: DATABASE_URL is not set')
    return 2
  }
  // Loaded only once the request is valid: the connection module brings the TLS and logger setup.
  const { createPostgresConnection } = await import('../db/connection')
  const { validateDatabaseConnection } = await import('../db/validate-connection')
  validateDatabaseConnection(databaseUrl, 'scripts/rebase-home')
  const sql = createPostgresConnection(databaseUrl, { max: 1, onnotice: () => {} })
  try {
    let result: RebaseHomeResult
    try {
      result = await rebaseHomePaths(sql, args.from, args.to, {
        dryRun: args.dryRun,
        structuredOnly: args.structuredOnly,
        force: args.force,
        onProgress: (message) => console.error(`rebase-home: ${message}`),
      })
    } catch (error) {
      if (error instanceof RebaseHomeTargetPresentError) {
        printTargetCounts(error.targetCounts, error.textTargetCounts)
        console.error(`rebase-home: ${error.message}`)
        return 3
      }
      throw error
    }
    const { counts, targetCounts, textTargetCounts } = result
    printCounts(counts)
    if (args.dryRun) printTargetCounts(targetCounts, textTargetCounts)
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0)
    console.error(
      args.dryRun
        ? `rebase-home: dry run — ${total} row(s) would move from ${args.from} to ${args.to}; nothing was written`
        : `rebase-home: ${total} row(s) moved from ${args.from} to ${args.to}`
    )
    return 0
  } finally {
    await sql.end()
  }
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`rebase-home: ${error instanceof Error ? error.message : String(error)}`)
      process.exit(1)
    })
}
