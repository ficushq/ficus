import { readFileSync } from 'fs'

/**
 * Postgres TLS resolution — the ONE place that decides whether a connection
 * is merely encrypted or actually AUTHENTICATED.
 *
 * `sslmode=require` gets you encryption and nothing else: postgres.js maps the
 * bare strings 'require'/'allow'/'prefer' onto `rejectUnauthorized: false`, so
 * any host that can intercept the TCP connection can present its own
 * certificate and read (or rewrite) the session. On Ficus's hosted platform the
 * database sits in a VPC that TENANT VMs also sit on, and tenant VMs are
 * treated as compromisable by design — customers run agents on them. So
 * `require` leaves one tenant able to harvest another tenant's database
 * credentials. Supplying a CA is what closes that: an ssl OBJECT takes
 * postgres.js's `typeof ssl === 'object'` branch instead, leaving node's
 * certificate-chain AND hostname (servername) checks switched on, i.e.
 * verify-full.
 *
 * Kept deliberately dependency-free (node:fs only) so drizzle.config.ts can
 * import it: `bun run db:migrate` builds its connection through drizzle-kit,
 * NOT through createPostgresConnection, and a TLS change that only covers the
 * runtime path leaves migrations silently on a different footing — the exact
 * shape of the bug fixed in 4f673b7f.
 */

/**
 * Legacy seam: AWS RDS publishes one global CA bundle, and hosts are
 * self-identifying, so the path is implied rather than configured. Everything
 * else supplies a CA explicitly (sslrootcert / DATABASE_CA_PATH).
 */
export const RDS_CA_PATH = '/usr/local/share/ca-certificates/aws-rds-global-bundle.crt'

export interface DatabaseTls {
  /**
   * The DSN to hand to postgres.js, with `sslrootcert` REMOVED.
   *
   * postgres.js recognises `sslmode` (and deletes it) but not `sslrootcert`,
   * and every query parameter it does not recognise is copied into the
   * startup packet as a server GUC — where postgres answers
   * `FATAL: unrecognized configuration parameter "sslrootcert"` (SQLSTATE
   * 42704) and the connection never opens. Verified against a real postgres,
   * on both the runtime path and `drizzle-kit migrate`.
   */
  connectionString: string
  /** PEM contents of the CA to verify the server against, when one is configured. */
  ca?: string
}

/** Where a configured CA came from, so a failure can name the knob to fix. */
interface CaSource {
  path: string
  origin: string
}

function findCaSource(url: URL, env: NodeJS.ProcessEnv, caPathEnvVar: string): CaSource | undefined {
  const fromDsn = url.searchParams.get('sslrootcert')
  if (fromDsn) return { path: fromDsn, origin: "the DSN's sslrootcert" }

  const fromEnv = env[caPathEnvVar]
  if (fromEnv) return { path: fromEnv, origin: caPathEnvVar }

  if (url.hostname.includes('rds.amazonaws.com')) return { path: RDS_CA_PATH, origin: 'the AWS RDS CA bundle' }

  return undefined
}

/**
 * Resolve the CA (if any) for `connectionString`, and return the DSN that is
 * safe to hand to postgres.js.
 *
 * Resolution order — most specific first:
 *   1. the DSN's own `sslrootcert` (per-connection, and what tenant DSNs carry)
 *   2. `caPathEnvVar` (process-wide, for a DSN the operator does not control)
 *   3. an `rds.amazonaws.com` host's implied global bundle
 *
 * A DSN with none of those is returned untouched and WITHOUT an `ssl` key, so
 * the caller can omit the option entirely: passing `ssl: undefined`
 * explicitly is not the same as omitting it — postgres.js reads
 * present-but-undefined as "no TLS" and stops honouring the DSN's own
 * `sslmode` (4f673b7f). Plain local postgres in dev/test keeps working
 * because of that, and `sslmode=require` keeps working because postgres.js
 * still sees it.
 *
 * THROWS when a CA is configured but unreadable. It must never fall back to
 * `{ rejectUnauthorized: false }`: that turns a misconfiguration into silent,
 * unauthenticated TLS — a connection that looks healthy while offering an
 * on-path attacker everything. A loud failure at startup is strictly better
 * than a quiet downgrade in production.
 */
export function resolveDatabaseTls(
  connectionString: string,
  { env = process.env, caPathEnvVar = 'DATABASE_CA_PATH' }: { env?: NodeJS.ProcessEnv; caPathEnvVar?: string } = {}
): DatabaseTls {
  let url: URL
  try {
    url = new URL(connectionString)
  } catch {
    // Not a parseable DSN (postgres.js also accepts other forms). Nothing to
    // strip and nothing to resolve from it — fall back to the env var only.
    const caPath = env[caPathEnvVar]
    if (!caPath) return { connectionString }
    return { connectionString, ca: readCa(caPath, caPathEnvVar) }
  }

  const source = findCaSource(url, env, caPathEnvVar)
  if (url.searchParams.has('sslrootcert')) {
    url.searchParams.delete('sslrootcert')
    connectionString = url.toString()
  }
  if (!source) return { connectionString }
  return { connectionString, ca: readCa(source.path, source.origin) }
}

function readCa(path: string, origin: string): string {
  try {
    return readFileSync(path, 'utf-8')
  } catch (err) {
    throw new Error(
      `Postgres CA certificate configured by ${origin} could not be read: ${path} ` +
        `(${err instanceof Error ? err.message : String(err)}). ` +
        'Refusing to connect without certificate verification — fix the path/permissions, ' +
        "or remove the CA setting to fall back to the DSN's own sslmode."
    )
  }
}
