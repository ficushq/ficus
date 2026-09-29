/**
 * Pure helpers for the Channels settings form.
 *
 * A "channel" connects a Discord/Slack/Telegram bot to Ficus. These helpers
 * translate between the honest, provider-first UI shown to operators and the
 * raw shapes the backend already stores (providerConfig, channelSquadMap) —
 * the API contract is not touched.
 */

export type ProviderId = 'discord' | 'slack' | 'telegram'

export interface ProviderMeta {
  id: ProviderId
  /** Capitalized display name shown in the picker. */
  label: string
  /** The single provider-specific identifier field (e.g. Discord's guild ID). */
  configField: {
    label: string
    placeholder: string
    hint: string
    configKey: string
  }
  /** The field used for each row's channel key in the squad-overrides list. */
  overrideIdField: {
    label: string
    placeholder: string
  }
}

export const PROVIDERS: ProviderMeta[] = [
  {
    id: 'discord',
    label: 'Discord',
    configField: {
      label: 'Discord server ID',
      placeholder: 'e.g. 123456789012345678',
      hint: 'Enable Developer Mode in Discord, then right-click your server icon and choose "Copy Server ID".',
      configKey: 'guildId',
    },
    overrideIdField: {
      label: 'Discord channel ID',
      placeholder: 'e.g. 987654321098765432',
    },
  },
  {
    id: 'slack',
    label: 'Slack',
    configField: {
      label: 'Slack workspace ID',
      placeholder: 'e.g. T0123ABCD',
      hint: 'Found in Slack under Settings & administration → Workspace settings, or in your workspace URL.',
      configKey: 'teamId',
    },
    overrideIdField: {
      label: 'Slack channel ID',
      placeholder: 'e.g. C0123ABCD',
    },
  },
  {
    id: 'telegram',
    label: 'Telegram',
    configField: {
      label: 'Telegram bot ID',
      placeholder: 'e.g. 123456789',
      hint: 'The numeric portion of your bot token, before the colon (from @BotFather).',
      configKey: 'botId',
    },
    overrideIdField: {
      label: 'Telegram chat ID',
      placeholder: 'e.g. -1001234567890',
    },
  },
]

export function getProviderMeta(provider: string): ProviderMeta {
  return PROVIDERS.find((p) => p.id === provider) ?? PROVIDERS[0]
}

/** Build the providerConfig object the backend stores for this provider + value. */
export function buildProviderConfig(provider: string, value: string): Record<string, unknown> {
  return { [getProviderMeta(provider).configField.configKey]: value }
}

/** Extract the provider-specific config value from a stored providerConfig object. */
export function extractProviderConfigValue(
  provider: string,
  config: Record<string, unknown> | null | undefined
): string {
  if (!config) return ''
  const value = config[getProviderMeta(provider).configField.configKey]
  if (typeof value === 'string') return value
  return value != null ? String(value) : ''
}

function randomHex(length: number): string {
  const byteCount = Math.ceil(length / 2)
  const bytes = new Uint8Array(byteCount)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < byteCount; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, length)
}

/**
 * Auto-generate a channel id client-side: `<provider>-<6 hex chars>`.
 * The backend's only constraints on this key are length (<=100) and
 * uniqueness (enforced with a 409 on create) — nobody types this value.
 */
export function generateChannelId(provider: string): string {
  return `${provider}-${randomHex(6)}`
}

export interface OverrideRow {
  /** The provider channel id this override applies to. */
  key: string
  /** The squad id messages from that channel should route to. */
  squadId: string
}

/**
 * Convert a stored channelSquadMap into editable rows. Values that aren't
 * strings (the schema is Record<string,string>, but hand-written YAML/JSON
 * could smuggle something else in) are coerced to a string rather than
 * dropped, so nothing is silently destroyed. Keys and values are trimmed on
 * load — the same normalization overrideRowsToMap applies on save — so an
 * untouched resave of an already-loaded map is byte-identical (whitespace is
 * normalized once, on load, rather than silently mutating on the next save).
 */
export function mapToOverrideRows(map: Record<string, unknown> | null | undefined): OverrideRow[] {
  if (!map) return []
  return Object.entries(map).map(([key, value]) => ({
    key: key.trim(),
    squadId: typeof value === 'string' ? value.trim() : value != null ? String(value).trim() : '',
  }))
}

/**
 * Serialize rows back to the exact map shape the backend stores. Rows where
 * both fields are blank are dropped silently (an untouched added row);
 * partially-filled rows are the caller's responsibility to validate before
 * calling this (see validateOverrideRows).
 */
export function overrideRowsToMap(rows: OverrideRow[]): Record<string, string> {
  const map: Record<string, string> = {}
  for (const row of rows) {
    const key = row.key.trim()
    const squadId = row.squadId.trim()
    if (!key && !squadId) continue
    if (!key || !squadId) continue
    map[key] = squadId
  }
  return map
}

/**
 * Returns the indexes of rows that are partially filled (one field set, the
 * other blank) — these must be completed or removed before saving, since
 * silently dropping them would discard operator intent.
 */
export function invalidOverrideRowIndexes(rows: OverrideRow[]): number[] {
  return rows.reduce<number[]>((acc, row, i) => {
    const key = row.key.trim()
    const squadId = row.squadId.trim()
    const filledCount = (key ? 1 : 0) + (squadId ? 1 : 0)
    if (filledCount === 1) acc.push(i)
    return acc
  }, [])
}
