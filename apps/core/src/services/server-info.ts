import type { ServerInfo } from '@ficus/shared'
import corePackage from '../../package.json'
import { getBuildVersion } from './machines/usage-reporter'

/** Deliberately contains no accounts, providers, paths, secrets, or role information. */
export async function getServerInfo(): Promise<ServerInfo> {
  const build = await getBuildVersion().catch(() => null)
  return {
    product: 'ficus',
    version: corePackage.version,
    revision: build?.commitSha ?? null,
    apiVersion: 1,
    capabilities: {
      'workstreams.workflow-runs': 1,
      'workstreams.assigned-reviewers': 1,
      'workstreams.save-workflow': 1,
      'auth.signup-default-role': 1,
    },
  }
}
