/** Commit-signing state of one GitHub connection, as the integration card shows it. */
export interface GitHubCommitSigningStatus {
  state: 'on' | 'off'
  /** `SHA256:…` fingerprint of the signing key, when on. */
  fingerprint?: string
  enabledAt?: string
  /** Live check that the key is still on the GitHub account; null when GitHub could not be asked. */
  registeredOnGitHub?: boolean | null
}

/** Why turning signing on failed; the card turns each into a fix-it message. */
export type GitHubCommitSigningErrorCode =
  | 'permission_missing'
  | 'connection_unusable'
  | 'key_rejected'
  | 'github_unavailable'

/**
 * Whether a GitHub account signs commits right now:
 * - `on`: commits committed as one of `signsFor` are signed with this account's key.
 * - `off`: signing is turned off (or was never set up) for the account.
 * - `needs_attention`: signing is turned on but nothing is signed until the
 *   account is fixed (disabled, reconnect required, or its key was removed on GitHub).
 */
export type GitHubCommitSigningState = 'on' | 'off' | 'needs_attention'

/** Commit signing of one GitHub connection, as `ficus integration list/get` show it. Never key material. */
export interface GitHubCommitSigningSummary {
  state: GitHubCommitSigningState
  /** GitHub login of the account that owns the signing key. */
  login: string
  /** Committer emails signed with this account's key; empty unless `state` is `on`. */
  signsFor: string[]
  /** `SHA256:…` fingerprint of the public signing key, when one is registered. */
  fingerprint?: string
}

/** Which of a squad's attached GitHub accounts sign its agents' commits. */
export interface GitHubSquadCommitSigning {
  /** The squad's default attachment (used by `git` and `gh`), whether or not it signs. */
  defaultConnectionId: string | null
  /** Every GitHub account attached to the squad. The key is chosen by the commit's committer email. */
  accounts: (GitHubCommitSigningSummary & { connectionId: string; isDefault: boolean })[]
}
