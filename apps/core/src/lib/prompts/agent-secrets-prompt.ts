/**
 * Prompt section telling an agent which per-agent secrets it has: env var
 * NAMES and the file path only, never a value (services/agent/secrets.ts).
 */

import { agentSecretNamesForSandbox } from '../../services/agent/secrets'
import { agentSecretsSandboxPath } from '../../services/sandbox/agent-secrets-file'

export function buildAgentSecretsPrompt(
  names: readonly string[],
  secretsPath: string,
  opts: { sharesParentBox?: boolean } = {}
): string {
  if (names.length === 0) return ''
  const owner = opts.sharesParentBox
    ? 'were given to your parent agent, and you inherit them because you share its sandbox'
    : 'were given to you alone (and to subagents you dispatch, which share your sandbox)'
  return [
    '## Per-agent secrets',
    '',
    `These Secret Store keys ${owner}: ${names.map((name) => `\`${name}\``).join(', ')}.`,
    `Every \`bash\` command you run has them as environment variables (for example \`"$${names[0]}"\`). They are not available in \`squad_bash\` or to other squad members. For other processes in your sandbox, source \`${secretsPath}\` (mode 0600).`,
    'Never print, echo, log, commit or copy these values into files, messages, the shared workspace or memory; pass them to commands by variable name. Values that appear in tool output are redacted.',
  ].join('\n')
}

/** The section for a sandbox, or '' when it has no per-agent secrets. */
export async function agentSecretsPromptForSandbox(
  sandboxId: string,
  opts: { sharesParentBox?: boolean } = {}
): Promise<string> {
  const names = await agentSecretNamesForSandbox(sandboxId)
  return buildAgentSecretsPrompt(names, agentSecretsSandboxPath(sandboxId), opts)
}
