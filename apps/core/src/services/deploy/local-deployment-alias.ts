/**
 * Local app hostname aliases.
 *
 * On a hosted instance an app is served at `<tenant>--<first 12 hex of its
 * id>.<apps domain>`. An alias gives it `<tenant>--<alias>.<apps domain>`
 * instead (e.g. `noah--dashboard.ficus.garden`). The host is what maps a browser
 * request to an app, so an alias is held to rules that keep that mapping
 * unambiguous:
 *   - plain lowercase ASCII DNS label characters with single hyphens: no `--`
 *     (it is the tenant/app delimiter, and `xn--` is the punycode marker), no
 *     leading or trailing hyphen, nothing a browser would normalize differently;
 *   - never the 12-hex id form, which would read as another app's id host;
 *   - not a reserved name;
 *   - `<tenant>--<alias>` within the 63-character DNS label limit;
 *   - unique per instance (a database unique index), and a freed alias is held
 *     for {@link LOCAL_DEPLOYMENT_ALIAS_COOLDOWN_MS} before another app may
 *     claim it, so cookies a browser kept for the old app never reach a new one.
 */

/** How long a freed alias stays unavailable to every app but the one that freed it. */
export const LOCAL_DEPLOYMENT_ALIAS_COOLDOWN_MS = 24 * 60 * 60 * 1000

const DNS_LABEL_MAX_LENGTH = 63
const ALIAS_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const ID_HOST_LABEL_PATTERN = /^[0-9a-f]{12}$/

/**
 * Names no app may take: they read as Ficus or infrastructure endpoints on the
 * apps domain, which would make a convincing phishing host.
 */
export const RESERVED_LOCAL_DEPLOYMENT_ALIASES: ReadonlySet<string> = new Set([
  'account',
  'accounts',
  'admin',
  'administrator',
  'api',
  'app',
  'apps',
  'assets',
  'auth',
  'autoconfig',
  'autodiscover',
  'billing',
  'cdn',
  'dns',
  'docs',
  'ficus',
  'ftp',
  'help',
  'imap',
  'internal',
  'localhost',
  'login',
  'logout',
  'mail',
  'mx',
  'ns1',
  'ns2',
  'oauth',
  'platform',
  'pop',
  'root',
  'security',
  'smtp',
  'sso',
  'static',
  'status',
  'support',
  'system',
  'webmail',
  'www',
])

/** A refused alias: the message is safe to show the caller. */
export class LocalDeploymentAliasError extends Error {
  constructor(
    message: string,
    /** `invalid` is the caller's input; `conflict` is another app holding (or recently holding) it. */
    readonly kind: 'invalid' | 'conflict' | 'unavailable'
  ) {
    super(message)
    this.name = 'LocalDeploymentAliasError'
  }
}

/**
 * Whether `value` has the shape of an alias (pattern, no id form, not
 * reserved). Used to reject a route parameter before any database lookup;
 * {@link normalizeLocalDeploymentAlias} is the full check for a new alias.
 */
export function isWellFormedLocalDeploymentAlias(value: string): boolean {
  return (
    value.length <= DNS_LABEL_MAX_LENGTH &&
    ALIAS_PATTERN.test(value) &&
    !ID_HOST_LABEL_PATTERN.test(value) &&
    !RESERVED_LOCAL_DEPLOYMENT_ALIASES.has(value)
  )
}

/**
 * The stored form of a requested alias, or a {@link LocalDeploymentAliasError}.
 * Surrounding whitespace is trimmed and ASCII upper case lowered (`Dashboard`
 * is `dashboard`, as a browser would read the host); any non-ASCII character
 * is refused outright rather than normalized, so no Unicode case or
 * compatibility mapping can turn one input into someone else's alias.
 */
export function normalizeLocalDeploymentAlias(raw: unknown, tenantLabel: string): string {
  if (typeof raw !== 'string') throw new LocalDeploymentAliasError('Alias must be a string', 'invalid')
  const trimmed = raw.trim()
  if (!trimmed) throw new LocalDeploymentAliasError('Alias must not be empty', 'invalid')
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7f]/.test(trimmed)) {
    throw new LocalDeploymentAliasError('Alias may only use the letters a-z, digits and hyphens', 'invalid')
  }
  const alias = trimmed.toLowerCase()
  if (alias.includes('--')) {
    throw new LocalDeploymentAliasError('Alias must not contain two hyphens in a row', 'invalid')
  }
  if (alias.startsWith('-') || alias.endsWith('-')) {
    throw new LocalDeploymentAliasError('Alias must not start or end with a hyphen', 'invalid')
  }
  if (!ALIAS_PATTERN.test(alias)) {
    throw new LocalDeploymentAliasError('Alias may only use the letters a-z, digits and hyphens', 'invalid')
  }
  if (ID_HOST_LABEL_PATTERN.test(alias)) {
    throw new LocalDeploymentAliasError('Alias must not look like an app id (12 hex characters)', 'invalid')
  }
  if (RESERVED_LOCAL_DEPLOYMENT_ALIASES.has(alias)) {
    throw new LocalDeploymentAliasError(`Alias "${alias}" is reserved`, 'invalid')
  }
  const maxLength = DNS_LABEL_MAX_LENGTH - tenantLabel.length - 2
  if (alias.length > maxLength) {
    throw new LocalDeploymentAliasError(
      `Alias must be at most ${maxLength} characters (the host label ${tenantLabel}--<alias> is limited to ${DNS_LABEL_MAX_LENGTH})`,
      'invalid'
    )
  }
  return alias
}
