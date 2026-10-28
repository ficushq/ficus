import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { INTEGRATION_BIN_RELATIVE_PATH, integrationWrapperPreamble } from '@ficus/shared/integration-wrapper-path'
import { getHomeDir } from '../../../lib/utils/home'
import { getSquadWorkspacePath } from '../../squad/workspace'
import { hostBinDir } from './env'

const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`

/** Managed Bash rc: usual login initialization, then managed PATH. Never sources squad credentials. */
export function renderHostTerminalBootstrap(options: {
  systemProfile: string
  userProfiles: string[]
  pathPrefix: string[]
}): string {
  return [
    '# Ficus human terminal bootstrap. No agent identity or integration credentials.',
    `[ -r ${quote(options.systemProfile)} ] && . ${quote(options.systemProfile)}`,
    `for profile in ${options.userProfiles.map(quote).join(' ')}; do`,
    '  if [ -r "$profile" ]; then . "$profile"; break; fi',
    'done',
    'unset profile',
    'unset FICUS_TOKEN FICUS_AGENT_CONTEXT FICUS_AGENT_ID FICUS_AUTH_STORE FICUS_IDENTITY_TOKEN FICUS_IDENTITY_AUTH_STORE FICUS_IDENTITY_AGENT_ID',
    'unset -f gh 2>/dev/null || true',
    integrationWrapperPreamble(options.pathPrefix.join(':'), false).trimEnd(),
    '',
  ].join('\n')
}

/** Store only token-free startup instructions in Core-owned storage, not the operator's repo/profile. */
export function ensureHostTerminalBootstrap(squadId: string | undefined, home: string): string {
  const directory = join(getHomeDir(), 'host', 'terminals', squadId ?? 'solo')
  mkdirSync(directory, { recursive: true })
  const file = join(directory, 'bashrc'),
    temporary = join(directory, `.tmp-${crypto.randomUUID()}`)
  const content = renderHostTerminalBootstrap({
    systemProfile: '/etc/profile',
    userProfiles: ['.bash_profile', '.bash_login', '.profile'].map((name) => join(home, name)),
    pathPrefix: [
      hostBinDir(),
      ...(squadId ? [join(getSquadWorkspacePath(squadId), INTEGRATION_BIN_RELATIVE_PATH)] : []),
    ],
  })
  try {
    writeFileSync(temporary, content, { mode: 0o600 })
    renameSync(temporary, file)
  } finally {
    rmSync(temporary, { force: true })
  }
  return file
}
