import { consultantScratchPath, consultantSandboxSquadId } from '../../services/sandbox/consultant-sandbox'
/**
 * Workspace prompt section injected into every agent's system prompt.
 *
 * Single source of truth for how an agent's sandbox is laid out and which bash
 * tool to use. It is capability-driven so the guidance stays consistent across
 * ALL runner types instead of drifting between per-runner copies:
 *
 * - **Solo agents** (system-manager, artifact-builder, solo subagents): one
 *   private box, working directory = the resolved private dir, no shared
 *   workspace, no `squad_bash`.
 * - **Squad agents**: a private box (where `bash` runs) PLUS the shared squad
 *   workspace. squad-manager / squad-worker get `squad_bash` (the shared squad
 *   warm box); subagents inherit it only when the parent actually exposed it;
 *   a restricted custom agent may not.
 *
 * Pass the capabilities the runner actually wired up; the prompt then describes
 * exactly the areas and tools that agent has — nothing it lacks.
 *
 * EVERY path shown to the agent comes from `resolveWorkspaceLayout`, so the
 * text is correct on all runtimes: container mounts (`/private`,
 * `/workspace/<squadId>`) on k8s/docker, box-native homes
 * (`/home/<boxuser>/...`) on the vm runtime. Never hardcode a mount path in
 * this prose.
 *
 * On the host runtime, `bash` runs unsandboxed on the core's own machine and
 * can reach both the private dir and the shared workspace, so it reuses the
 * container prose for areas/tools; the only host-specific prose is the
 * "## Host runtime" section, which replaces the devbox section entirely.
 */

import { FOREGROUND_BASH_GUIDANCE } from '../bash-contract'

import { userInfo } from 'os'
import { isHostRuntime, isVmRuntime } from '../../services/sandbox/runtime'
import { resolveWorkspaceLayout } from '../../services/sandbox/workspace-layout'
import { filterToolsByPolicy } from '../tools'

export interface WorkspacePromptOptions {
  /** Squad id when the agent is squad-scoped (gets the shared squad workspace). Omit for solo agents. */
  squadId?: string
  /** Squad display name, shown alongside the shared workspace path. */
  squadName?: string
  /**
   * The agent's own sandbox id. Required for the vm runtime to resolve the
   * agent's box-native private dir; ignored by the container runtimes.
   */
  agentId?: string
  sandboxId?: string
  /** Whether the `squad_bash` tool is actually available in this session. */
  hasSquadBash?: boolean
  /** Whether this agent shares its sandbox (and private dir) with a parent + sibling subagents. */
  sharesParentBox?: boolean
  /** Exact effective environment tool names. Omit only for legacy callers that have the standard tool set. */
  toolNames?: string[]
  /** Whether this top-level agent can dispatch descendants into its private sandbox. */
  mayShareWithSubagents?: boolean
}

export function workspaceToolNamesForPolicy(
  allow?: string[] | null,
  deny?: string[] | null,
  hasSquadBash = false
): string[] {
  const names = ['bash', 'read', 'write', 'edit', ...(hasSquadBash ? ['squad_bash'] : [])]
  return filterToolsByPolicy(
    names.map((name) => ({ name })),
    allow,
    deny
  ).map((tool) => tool.name)
}

export function buildWorkspacePrompt(opts: WorkspacePromptOptions = {}): string {
  const {
    squadId,
    squadName,
    sandboxId,
    hasSquadBash: rawHasSquadBash = false,
    sharesParentBox = false,
    toolNames,
    mayShareWithSubagents = false,
  } = opts
  const capabilities = toolNames ? new Set(toolNames) : null
  const hasSquadBash = capabilities === null ? rawHasSquadBash : capabilities.has('squad_bash')
  const hasTool = (name: string) => capabilities === null || capabilities.has(name)
  const hasBash = hasTool('bash')
  const fileTools = ['read', 'write', 'edit'].filter(hasTool)
  const fileToolList = fileTools.map((name) => `\`${name}\``).join('/')
  const layout = resolveWorkspaceLayout({ squadId, sandboxId })
  const priv = consultantScratchPath(layout.privateMount, sandboxId, opts.agentId)
  const workspaceMount = squadId ? layout.workspaceMount : undefined
  const memoryMount = layout.memoryMount
  // On the vm runtime a squad member's box is a separate unix user from the
  // squad box: its `bash` CANNOT reach the shared squad workspace (only the
  // file tools — routed to the squad box — and `squad_bash` can). On the
  // container runtimes the shared workspace is a mount every member sees, so
  // `bash` reaches both areas. The prose below branches so each runtime's
  // description is TRUE — never soften this back into one claim.
  const vm = isVmRuntime()
  const host = isHostRuntime()

  const out: string[] = ['## Workspace & Sandbox', '']
  if (hasBash || hasSquadBash || fileTools.length > 0) {
    const available = [
      hasBash ? '`bash`' : null,
      hasSquadBash ? '`squad_bash`' : null,
      ...fileTools.map((t) => `\`${t}\``),
    ]
      .filter(Boolean)
      .join(', ')
    out.push(
      host
        ? `Your available filesystem and shell tools (${available}) execute directly on the Ficus host machine (no sandbox).`
        : `Your available filesystem and shell tools (${available}) execute inside authorized sandboxes.`
    )
    if (fileTools.length > 0) {
      out.push(`${fileToolList} require ABSOLUTE paths (starting with \`/\`) — relative paths are rejected.`)
    }
    out.push('')
  } else {
    out.push('You have no general filesystem or shell tools in this session.', '')
  }

  const sharedConsultants = Boolean(sandboxId && consultantSandboxSquadId(sandboxId))
  const privateVisibility = sharedConsultants
    ? 'your conversation scratch directory in the shared squad consultant runtime; other consultant chats can access this runtime'
    : sharesParentBox
      ? 'private from other squad teammates but shared with your parent agent and sibling subagents'
      : mayShareWithSubagents
        ? 'private from squad teammates, but shared with any subagents you dispatch'
        : 'YOUR private directory; no teammate can read it'
  const privateUse = sharedConsultants
    ? 'Keep scratch files here to avoid collisions. Do not modify other conversations’ directories, shared shell configuration, or credentials. This directory is not a secret store.'
    : sharesParentBox
      ? 'Do not treat it as a secret store because your parent and siblings can read it.'
      : mayShareWithSubagents
        ? 'Do not treat it as a secret store because dispatched subagents can read it.'
        : 'Use it for personal scratch, keys, and secrets.'
  const privateShellUse = sharesParentBox
    ? 'Because that area is shared with the parent and siblings, do not use it as a secret store.'
    : mayShareWithSubagents
      ? 'Because dispatched subagents can share that area, do not use it for sensitive material.'
      : 'Reserve it for exception-only personal scratch, private temporary artifacts, or sensitive material.'

  if (workspaceMount && vm) {
    const shared = squadName ? `the SHARED squad workspace (${squadName})` : 'the SHARED squad workspace'
    out.push(
      'You have two areas, both addressable by absolute path:',
      `- **\`${priv}\`** — ${privateVisibility}. ${hasBash ? `\`bash\` starts here, so \`${priv}\` is your default working directory. ` : ''}${privateUse}`,
      `- **\`${workspaceMount}\`** — ${shared}, visible to every squad member and to squad deployments. Keep shared project files here and collaborate.`,
      '',
      ...(fileTools.length > 0
        ? [
            `${fileToolList} reach BOTH areas by absolute path — file operations on \`${workspaceMount}/...\` are routed to the shared squad box automatically.`,
          ]
        : []),
      ...(hasBash
        ? [`Your \`bash\` runs in the inherited private box and CANNOT see \`${workspaceMount}\` at all.`]
        : []),
      ...(hasSquadBash
        ? [
            `Default to \`squad_bash\` for ALL repository and project commands — cloning, inspection, edits, git, dependencies, Docker/Compose, tests, builds, diagnostics, dev servers, and deployments. It starts in \`${workspaceMount}\`. Clone repositories ONLY into subdirectories of \`${workspaceMount}\` via \`squad_bash\` (e.g. \`git clone <url> repo-name\` run in \`squad_bash\`), never into \`${priv}\` or any stray sibling path outside it. The shared workspace is cleaned up automatically when the project completes.`,
          ]
        : [
            `You cannot execute commands in the shared workspace (you have no shared-runtime bash tool).${fileTools.length > 0 ? ` Use ${fileToolList} by absolute path for the operations those tools support.` : ''}`,
          ]),
      ''
    )
  } else if (workspaceMount) {
    const shared = squadName ? `the SHARED squad workspace (${squadName})` : 'the SHARED squad workspace'
    out.push(
      'You have two areas, both addressable by absolute path:',
      `- **\`${priv}\`** — ${privateVisibility}. ${hasBash ? `\`bash\` starts here, so \`${priv}\` is your default working directory until you change it. ` : ''}${privateUse}`,
      `- **\`${workspaceMount}\`** — ${shared}, visible to every squad member and to squad deployments. Keep shared project files here and collaborate.`,
      '',
      ...(hasSquadBash
        ? [
            `**For all repository/project commands, use \`squad_bash\` from \`${workspaceMount}\`** — its shared runtime, processes, tools, and caches are reusable by collaborators and local deployments.${hasBash ? ' Do not run project commands in private `bash` merely because it can see the workspace.' : ''}`,
            `Clone repositories ONLY into subdirectories of \`${workspaceMount}\` via \`squad_bash\` (e.g. \`cd ${workspaceMount} && git clone <url> repo-name\`), never into \`${priv}\` or any stray sibling path outside it. The shared workspace is cleaned up automatically when the project completes.`,
          ]
        : hasBash
          ? [
              `**Before any repo work, \`cd ${workspaceMount}/...\`** — your shell starts in \`${priv}\`, so repos cloned into the inherited working directory land in the wrong place.`,
              `Clone repositories ONLY into subdirectories of \`${workspaceMount}\` (e.g. \`cd ${workspaceMount} && git clone <url> repo-name\`), never into \`${priv}\` or any stray sibling path outside it. The shared workspace is cleaned up automatically when the project completes.`,
            ]
          : [
              `You have no shell tool for repository commands.${fileTools.length > 0 ? ` Use ${fileToolList} by absolute path for the operations those tools support.` : ''}`,
            ]),
      ''
    )
  } else {
    out.push(
      `Your private area is \`${priv}\` — ${privateVisibility}. ${hasBash ? '`bash` starts there. ' : ''}${privateUse} You have no shared squad workspace.${fileTools.length > 0 || hasBash ? ` Your accessible files live under \`${priv}\`.` : ''}`,
      ''
    )
  }

  if (sharesParentBox) {
    out.push(
      `You share this sandbox — including \`${priv}\` — with your parent agent and any sibling subagents, so treat \`${priv}\` as shared with them rather than exclusively yours.`,
      ''
    )
  } else if (mayShareWithSubagents) {
    out.push(
      `Subagents you dispatch inherit this sandbox, including \`${priv}\`; keep credentials and secrets out of it.`,
      ''
    )
  }

  // Which bash tool(s) the agent has, and when to reach for each.
  if (workspaceMount && hasSquadBash && vm) {
    out.push(
      hasBash ? '**Your two bash tools:**' : '**Your shared shell tool:**',
      ...(hasBash
        ? [`- **\`bash\`** runs in the inherited private box. It sees ONLY \`${priv}\`; ${privateShellUse}`]
        : []),
      `- **\`squad_bash\`** runs in the SHARED squad sandbox (the warm box that also hosts squad deployments), starting in \`${workspaceMount}\`. Default to \`squad_bash\` for ALL repository and project commands: inspection, edits, git, dependencies, Docker/Compose, tests, builds, diagnostics, dev servers, and deployments. It sees the squad memory files at \`${memoryMount}\`${hasBash ? ' (memory tools work from either shell)' : ''}.`,
      ''
    )
  } else if (workspaceMount && hasSquadBash) {
    out.push(
      hasBash ? '**Your two bash tools:**' : '**Your shared shell tool:**',
      ...(hasBash
        ? [
            `- **\`bash\`** runs in the inherited private sandbox and can read and write both \`${priv}\` and \`${workspaceMount}\`; ${privateShellUse}`,
          ]
        : []),
      `- **\`squad_bash\`** runs in the SHARED squad sandbox (the warm box that also hosts squad deployments). Default to \`squad_bash\` for ALL repository and project commands: inspection, edits, git, dependencies, Docker/Compose, tests, builds, diagnostics, dev servers, and deployments. ${hasBash ? `Both shell tools see the same \`${workspaceMount}\` files; only \`squad_bash\` shares the squad's live processes and installed tools. ` : ''}It sees the squad memory files at \`${memoryMount}\`.`,
      ''
    )
  } else if (workspaceMount && vm) {
    // Squad agent without squad_bash (for example a restricted custom agent) on the vm runtime.
    if (hasBash || fileTools.length > 0) {
      out.push(
        `${hasBash ? `\`bash\` runs in the inherited private box; it sees ONLY \`${priv}\` and CANNOT see \`${workspaceMount}\`.` : 'You have no shell tool.'}${fileTools.length > 0 ? ` ${fileToolList} DO reach \`${workspaceMount}\` by absolute path.` : ''} You have no shared-runtime bash and cannot execute commands in the shared workspace.`,
        ''
      )
    }
  } else if (workspaceMount && (hasBash || fileTools.length > 0)) {
    // Squad agent without squad_bash (for example a restricted custom agent).
    out.push(
      `${hasBash ? `You have a single \`bash\`, running in the inherited private sandbox; it can reach \`${priv}\` and \`${workspaceMount}\`.` : 'You have no shell tool.'}${fileTools.length > 0 ? ` ${fileToolList} can reach both areas by absolute path.` : ''} You do not have a separate shared-runtime bash.`,
      ''
    )
  }

  if (hasBash || hasSquadBash) out.push('', FOREGROUND_BASH_GUIDANCE)

  // Devbox guidance only makes sense when a shell tool is available.
  if ((hasBash || hasSquadBash) && host) {
    out.push(
      '## Host runtime',
      '',
      `You are running directly on the Ficus host machine as user \`${userInfo().username}\` with no sandbox or isolation. Use the tools already installed on this machine; do not attempt \`devbox\`, \`apk\`, or \`apt\` unless the user has asked you to install software. Be careful: commands affect the real machine.`
    )
  } else if (hasBash || hasSquadBash) {
    out.push(
      '## Installing Tools with Devbox',
      '',
      '**Devbox** is available in your sandbox — add packages with no setup:',
      '',
      '```bash',
      'devbox add ansible terraform python aws-cli',
      '```',
      '',
      `Added tools are automatically available in all subsequent ${hasBash ? '`bash`' : '`squad_bash`'} commands (no \`devbox shell\` needed) and persist across sessions. Prefer devbox over \`apk\`/\`apt\` — system packages are lost when the sandbox restarts. Thousands of tools are available via Nix.`
    )
    if (hasSquadBash) {
      out.push(
        '',
        `Run project and reusable toolchain changes with \`squad_bash\`, including \`devbox add\` and persistent language/tool installs.${hasBash ? ' Use private Devbox only for the same exception-only private work.' : ''} Devbox is a toolchain mechanism, not a replacement for project dependencies managed by the repository package policy.`
      )
    }
    out.push('', 'If a tool is not in devbox, `sudo apk add <package>` works as a fallback but will not persist.')
  }

  // Sandbox outages — what the structured error means and how recovery works.
  // Omitted on host: there is no sandbox to be OOM-killed or recreated, no
  // outage error is ever raised, and `sandbox_status` has nothing to report —
  // telling the agent to wait for a box to come back would be a dead end.
  if (host) return out.join('\n')

  out.push(
    '',
    '## Sandbox Outages',
    '',
    `Sandboxes occasionally go down mid-task (e.g. OOM-killed by a heavy command, or node-level issues). When that happens, ${capabilities === null ? 'bash, file, and browser tools' : 'sandbox-backed tools that are available to you'} return an error saying the sandbox is **currently unavailable**; recovery is automatic and you will be **notified** with a system message once the box is back online — do not busy-poll or give up on the task.`,
    'While waiting, keep working with the tools that do not need the sandbox (web, memory, messaging, planning), or pause if nothing else is actionable. Use the `sandbox_status` tool to check your box(es) live at any time — for example after an outage error or before a critical command.',
    'If the outage error mentions OOM, consider narrowing the failing command (scoped tests/lint, smaller builds) once the box is back.'
  )

  return out.join('\n')
}
