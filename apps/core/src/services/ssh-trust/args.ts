/**
 * Strict host-key pinning for one ssh connection: the host key must match an
 * entry for `alias` in `knownHostsPath`, a Core-written file holding exactly
 * the endpoint's trusted keys (`ssh-trust/index.ts`). DB-free so low-level ssh
 * callers can import it.
 */
export interface HostKeyPin {
  knownHostsPath: string
  alias: string
}

/**
 * The ssh options that check the host key strictly against `pin` and nothing
 * else. Command-line options beat every ssh_config, so no user or system
 * config can relax them.
 */
export function strictHostKeyArgs(pin: HostKeyPin): string[] {
  return [
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    `UserKnownHostsFile=${pin.knownHostsPath}`,
    '-o',
    'GlobalKnownHostsFile=/dev/null',
    '-o',
    `HostKeyAlias=${pin.alias}`,
    '-o',
    'UpdateHostKeys=no',
    '-o',
    'VerifyHostKeyDNS=no',
    '-o',
    'CheckHostIP=no',
  ]
}
