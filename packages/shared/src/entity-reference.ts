export type EntityReference = { kind: 'ws' | 'agent'; id: string }

/** The link scheme chat writes for work streams and agents: `ficus:ws:42`, `ficus:agent:<uuid>`. */
export const ENTITY_REFERENCE_SCHEME = 'ficus'

const REFERENCE_PATTERN = new RegExp(`^${ENTITY_REFERENCE_SCHEME}:(ws|agent):([0-9a-f-]{1,36})$`, 'i')

/** The link target for a work stream or agent reference. */
export function entityReferenceHref(kind: EntityReference['kind'], id: string): string {
  return `${ENTITY_REFERENCE_SCHEME}:${kind}:${id}`
}

/** Only canonical UUIDs and their prefixes; resolution must reject ambiguous IDs. */
export function parseEntityReference(value: string | undefined): EntityReference | null {
  const match = value?.match(REFERENCE_PATTERN)
  if (!match) return null
  const id = match[2]!.toLowerCase()
  if (match[1]!.toLowerCase() === 'ws' && /^[1-9]\d*$/.test(id) && Number(id) <= 2147483647) return { kind: 'ws', id }
  const template = 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'
  if ([...id].some((char, index) => (template[index] === '-' ? char !== '-' : !/[0-9a-f]/.test(char)))) return null
  return { kind: match[1]!.toLowerCase() as EntityReference['kind'], id }
}
