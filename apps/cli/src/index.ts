import { configureGlobalOptionScope } from './global-options'
import { Command } from 'commander'
import { buildInfo } from './build-info'
import { defaultGitSigningDependencies, isSshKeygenInvocation, runSshKeygenCompat } from './git-signing'
import { setSelectedBackend } from './config'
import { setOutputOptions } from './output'
import { registerActionCommands } from './commands/action'
import { registerAdminCommands } from './commands/admin'
import { registerAgentCommands } from './commands/agent'
import { registerAgentQuestionCommands } from './commands/agent-question'
import { registerAgentTypeCommands } from './commands/agent-type'
import { registerAssistantTaskCommands } from './commands/assistant-task'
import { registerAuthCommands } from './commands/auth'
import { registerChannelInstanceCommands } from './commands/channel-instance'
import { registerChatCommands } from './commands/chat'
import { registerDemoCommands } from './commands/demo'
import { registerDesktopCommands } from './commands/desktop'
import { registerDeployCommands } from './commands/deploy'
import { registerDiscordCommands } from './commands/discord'
import { registerAmtpCommands, registerRemoteCommands } from './commands/amtp'
import { registerImageCommands } from './commands/image'
import { registerIntegrationCommands } from './commands/integration'
import { registerInboxCommands } from './commands/inbox'
import { registerInstallCommands } from './commands/install'
import { registerMachinesCommands } from './commands/machines'
import { registerMemoryCommands } from './commands/memory'
import { registerNotificationConfigCommands } from './commands/notification-config'
import { registerMonitorCommands } from './commands/monitor'
import { registerSharedPromptCommands } from './commands/shared-prompt'
import { registerProviderAuthCommands } from './commands/provider-auth'
import { registerRemoteHostsCommands } from './commands/remote-hosts'
import { registerScheduleCommands } from './commands/schedule'
import { registerSecretCommands } from './commands/secret'
import { registerSearchCommands } from './commands/search'
import { registerServerCommands } from './commands/server'
import { registerSkillCommands } from './commands/skill'
import { registerSlotCommands } from './commands/slot'
import { registerSquadCommands } from './commands/squad'
import { registerSquadEnvCommands } from './commands/squad-env'
import { registerSquadPresetCommands } from './commands/squad-preset'
import { registerSystemCommands } from './commands/system'
import { registerUpdateCommands } from './commands/update'
import { registerRoleCommands, registerUserCommands } from './commands/user'
import { registerWatchCommands } from './commands/watch'
import { registerWebhookCommands } from './commands/webhook'
import { registerWhoamiCommands } from './commands/whoami'
import { registerWorkerCommands } from './commands/worker'
import { registerWorkstreamCommands } from './commands/workstream'
import { registerWorkflowCommands } from './commands/workflow'

const program = new Command()

program
  .name('ficus')
  .description('Ficus CLI - AI-powered task management')
  .version(`${buildInfo.version} (${buildInfo.commit}, ${buildInfo.buildDate})`)
  .option('--json', 'Output in JSON format')
  .option('--quiet', 'Minimal output')
  .option('--backend <label>', 'Use a labeled Ficus auth backend for this command only')
  .hook('preAction', (_thisCommand, actionCommand) => {
    const opts = actionCommand.optsWithGlobals()
    setOutputOptions({ json: opts.json, quiet: opts.quiet })
    setSelectedBackend(opts.backend)
  })

registerActionCommands(program)
registerSearchCommands(program)
registerAdminCommands(program)
registerAgentCommands(program)
registerAgentQuestionCommands(program)
registerAgentTypeCommands(program)
registerAssistantTaskCommands(program)
registerAuthCommands(program)
registerChannelInstanceCommands(program)
registerChatCommands(program)
registerDemoCommands(program)
registerDesktopCommands(program)
registerDeployCommands(program)
registerDiscordCommands(program)
registerAmtpCommands(program)
registerRemoteCommands(program)
registerImageCommands(program)
registerIntegrationCommands(program)
registerInboxCommands(program)
registerInstallCommands(program)
registerMachinesCommands(program)
registerMemoryCommands(program)
registerMonitorCommands(program)
registerNotificationConfigCommands(program)
registerProviderAuthCommands(program)
registerRemoteHostsCommands(program)
registerScheduleCommands(program)
registerSecretCommands(program)
registerServerCommands(program)
registerSkillCommands(program)
registerSharedPromptCommands(program)
registerSlotCommands(program)
registerSquadCommands(program)
registerSquadEnvCommands(program)
registerSquadPresetCommands(program)
registerSystemCommands(program)
registerUpdateCommands(program)
registerUserCommands(program)
registerRoleCommands(program)
registerWatchCommands(program)
registerWebhookCommands(program)
registerWhoamiCommands(program)
registerWorkerCommands(program)
registerWorkstreamCommands(program)
registerWorkflowCommands(program)

// git runs `ficus` as its gpg.ssh.program (squad commit signing) with ssh-keygen's argv.
const args = process.argv.slice(2)
if (isSshKeygenInvocation(args)) {
  void runSshKeygenCompat(args, defaultGitSigningDependencies()).then((code) => {
    process.exitCode = code
  })
} else {
  configureGlobalOptionScope(program)
  program.parse()
}
