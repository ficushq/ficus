import type { SecretMetadata } from '../../api/secrets'

/** Frontend registry: maps raw env var keys to friendly display info */
export interface SecretRegistryEntry {
  key: string
  name: string
  description: string
  category: string
  /** If true, changing this secret requires a system restart to take effect */
  requiresRestart?: boolean
  /** If false, value is shown as plaintext (not a password field). Default: true */
  sensitive?: boolean
  /**
   * If true, this entry disappears entirely once the platform manages its key —
   * for credentials a tenant on a managed instance has no reason to know exist
   * (APNs, the VAPID subject: pure plumbing for push we run for them). Without
   * the flag a managed key still renders as a read-only "Managed by your
   * platform" row, which stays the right treatment for values a tenant SHOULD
   * know are configured.
   */
  hideIfManaged?: boolean
  /** Hosted infrastructure credentials are configured by the platform operator. */
  hideWhenHosted?: boolean
}

export const SECRET_REGISTRY: SecretRegistryEntry[] = [
  // Git (sandbox)
  {
    key: 'GIT_USER_NAME',
    name: 'Git Author Name',
    description: 'Default git commit author name for sandbox agents',
    category: 'Git',
    sensitive: false,
  },
  {
    key: 'GIT_USER_EMAIL',
    name: 'Git Author Email',
    description: 'Default git commit author email for sandbox agents',
    category: 'Git',
    sensitive: false,
  },
  // Machines (VM sandbox runtime)
  {
    key: 'exe-provider-ssh-key',
    name: 'exe.dev account SSH private key',
    description:
      'The SSH PRIVATE key registered to your exe.dev account (Settings → SSH keys). Ficus uses it to run the exe.dev lobby API and to reach provisioned VMs. Leave unset for BYO-SSH only.',
    category: 'Machines',
    sensitive: true,
    hideWhenHosted: true,
  },
]

export function buildSecretRegistry(_metadata: SecretMetadata[]): SecretRegistryEntry[] {
  return [...SECRET_REGISTRY]
}

/**
 * Drop entries the platform manages AND that asked to disappear when it does.
 * Categories are derived from what survives this filter, so a category whose
 * every entry is hidden simply never gets built — no category-name special
 * cases anywhere.
 */
export function visibleRegistryEntries(
  registry: SecretRegistryEntry[],
  managedKeys: Set<string>,
  context: { managed?: boolean; exeBacked?: boolean } = {}
): SecretRegistryEntry[] {
  return registry.filter((entry) => {
    if (entry.hideIfManaged === true && managedKeys.has(entry.key)) return false
    if (entry.hideWhenHosted === true && context.managed === true) return false
    return true
  })
}

/** Group secrets by category, preserving order */
export function groupByCategory(
  registry: SecretRegistryEntry[],
  metadata: SecretMetadata[]
): { category: string; secrets: (SecretRegistryEntry & { meta: SecretMetadata })[] }[] {
  const metaMap = new Map(metadata.map((m) => [m.key, m]))
  const groups: Map<string, (SecretRegistryEntry & { meta: SecretMetadata })[]> = new Map()

  for (const entry of registry) {
    const meta = metaMap.get(entry.key) ?? {
      key: entry.key,
      isSet: false,
      updatedAt: null,
      updatedBy: null,
    }
    if (!groups.has(entry.category)) {
      groups.set(entry.category, [])
    }
    groups.get(entry.category)!.push({ ...entry, meta })
  }

  return Array.from(groups.entries()).map(([category, secrets]) => ({
    category,
    secrets,
  }))
}

/** True when saving this key triggers GitHub validation UX. */
export function isGitHubTokenSecretKey(_key: string): boolean {
  return false
}
