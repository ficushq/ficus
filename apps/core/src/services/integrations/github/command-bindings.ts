// Token-free, per-command Git configuration shared by every runtime.
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

/**
 * Resolve credentials on each invocation so long-lived shells see rotation and detach.
 *
 * With `signingPublicKey`, agents' commits and tags are also signed: git calls
 * `ficus` as its `gpg.ssh.program`, which has Core sign (the private half never
 * enters the sandbox). The key named here only switches signing on: Core picks
 * the key of the attached account the commit's committer email belongs to,
 * leaves the commit unsigned when that account's signing is off, and refuses
 * when no attached account owns the email. Command-line `-c` outranks any
 * repo-local config. Signing applies only when `FICUS_TOKEN` is set, i.e. to agent
 * commands: a human terminal cannot reach the signer, and must not have every
 * commit fail.
 */
export function githubCommandBindings(squadId: string, signingPublicKey?: string): string {
  const squad = shellQuote(squadId)
  const credential = `-c credential.https://github.com.helper= -c ${shellQuote(`credential.https://github.com.helper=!f() { command ficus integration exec github --squad ${squad} -- gh auth git-credential "$@"; }; f`)}`
  const signing = signingPublicKey
    ? [
        '-c gpg.format=ssh',
        '-c commit.gpgsign=true',
        '-c tag.gpgsign=true',
        `-c ${shellQuote(`user.signingkey=key::${signingPublicKey.trim()}`)}`,
        '-c gpg.ssh.program=ficus',
      ].join(' ')
    : undefined
  const git = signing
    ? `git() { if [ -n "\${FICUS_TOKEN:-}" ]; then FICUS_GIT_SIGNING_SQUAD=${squad} command git ${credential} ${signing} "$@"; else command git ${credential} "$@"; fi; }`
    : `git() { command git ${credential} "$@"; }`
  return (
    [
      // Retire inherited legacy shell functions so PATH wrappers handle nested calls.
      'unset -f gh 2>/dev/null || true',
      git,
      'if [ -n "${BASH_VERSION:-}" ]; then export -f git; fi',
    ].join('\n') + '\n'
  )
}
