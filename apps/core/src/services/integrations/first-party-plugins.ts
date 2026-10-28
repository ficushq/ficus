import { linearPlugin } from './linear/plugin'
import type { IntegrationPluginV1 } from './plugin'
import { bigbrainPlugin } from './bigbrain/plugin'
import { notionPlugin } from './notion/plugin'
import { githubPlugin } from './github/plugin'
import { channelPlugins } from './channels/plugins'
import { deploymentPlugins } from './deployment/plugins'

export const firstPartyIntegrationPlugins: readonly IntegrationPluginV1<any, any, any>[] = Object.freeze([
  bigbrainPlugin,
  notionPlugin,
  githubPlugin,
  linearPlugin,
  ...deploymentPlugins,
  channelPlugins.discord,
  channelPlugins.slack,
  channelPlugins.telegram,
])

export function firstPartyIntegrationPlugin(key: string): IntegrationPluginV1<any, any, any> | undefined {
  return firstPartyIntegrationPlugins.find((plugin) => plugin.key === key)
}
