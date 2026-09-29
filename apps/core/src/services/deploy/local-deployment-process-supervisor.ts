import type { ISandboxManager } from '../sandbox'
import { getSandboxManager } from '../sandbox'
import { loadLaunchPathLines, recordLaunchPathCommand, runWithLaunchPath } from '../sandbox/launch-path'
import { resolveWorkspaceLayout } from '../sandbox/workspace-layout'
import { localDeploymentProxyPath } from './local-deployment-auth'
import {
  buildResolveAttachedLogPathCommand,
  buildStreamAttachedLogCommand,
  LocalDeploymentLogPathOutsideWorkspaceError,
  parseResolveAttachedLogPathOutput,
  shellQuote,
} from './local-deployment-log-path'
import { getHostedAppsDomain } from './local-deployment-service'

export interface StartManagedLocalDeploymentArgs {
  localDeploymentId: string
  sandboxId: string
  command: string
  cwd?: string | null
  port: number
}

function sessionNameForLocalDeployment(localDeploymentId: string): string {
  return `tau-local-deployment-${localDeploymentId.slice(0, 8)}`
}

function localDeploymentDir(sandboxId: string, localDeploymentId: string): string {
  const squadId = sandboxId.replace(/^squad_/, '')
  const { workspaceMount } = resolveWorkspaceLayout({ squadId })
  return `${workspaceMount}/.tau/local-deployments/${localDeploymentId}`
}

/**
 * `date -Is` is a GNU abbreviation BSD date rejects ("invalid argument 's' for
 * -I"), so on the host runtime on macOS it exited 1 under `set -e` and killed
 * the launcher on its FOURTH line — before the log file existed, before the
 * app ran. The UI then sat on "Waiting for logs…" forever because `tail -F`
 * was following a file nothing would ever write to. `+FORMAT` is POSIX and
 * byte-identical on GNU and BSD; `|| true` additionally demotes these
 * breadcrumbs (nothing reads them — they are diagnostics) so no future
 * portability wrinkle in a timestamp can ever again abort a deployment.
 */
const TIMESTAMP = `date -u '+%Y-%m-%dT%H:%M:%SZ'`

export const LAUNCHER_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$FICUS_LOCAL_DEPLOYMENT_DIR/logs"
${TIMESTAMP} > "$FICUS_LOCAL_DEPLOYMENT_DIR/startedAt" || true
${loadLaunchPathLines('FICUS_LOCAL_DEPLOYMENT_DIR')}
cd "$FICUS_LOCAL_DEPLOYMENT_CWD"
set +e
{
  echo "[ficus] starting localDeployment $FICUS_LOCAL_DEPLOYMENT_ID on port $FICUS_LOCAL_DEPLOYMENT_PORT"
  ${runWithLaunchPath('FICUS_LOCAL_DEPLOYMENT_COMMAND')}
} 2>&1 | tee -a "$FICUS_LOCAL_DEPLOYMENT_DIR/logs/current.log"
status=\${PIPESTATUS[0]}
set -e
echo "$status" > "$FICUS_LOCAL_DEPLOYMENT_DIR/exitCode"
${TIMESTAMP} > "$FICUS_LOCAL_DEPLOYMENT_DIR/exitedAt" || true
exit "$status"
`

export class LocalDeploymentProcessSupervisor {
  constructor(private manager: ISandboxManager = getSandboxManager()) {}

  async startManagedLocalDeployment(args: StartManagedLocalDeploymentArgs): Promise<{ processId: string }> {
    const processId = sessionNameForLocalDeployment(args.localDeploymentId)
    const squadId = args.sandboxId.replace(/^squad_/, '')
    const { workspaceMount } = resolveWorkspaceLayout({ squadId })
    const dir = localDeploymentDir(args.sandboxId, args.localDeploymentId)
    const script = `${dir}/run.sh`
    const cwd = args.cwd?.trim() || workspaceMount
    const appEnv: Record<string, string> = {
      FICUS_LOCAL_DEPLOYMENT_ID: args.localDeploymentId,
      FICUS_LOCAL_DEPLOYMENT_PORT: String(args.port),
      // The conventional name. Ficus assigns the port now, so an app that reads
      // $PORT needs no configuration and cannot collide with a sibling box on
      // the same machine; FICUS_LOCAL_DEPLOYMENT_PORT stays for existing commands.
      PORT: String(args.port),
      // Hosted apps occupy their origin root; self-hosted apps keep the legacy
      // proxy prefix. Passing both through one variable lets framework config
      // stay portable without hardcoding a deployment id.
      FICUS_APP_BASE_PATH: getHostedAppsDomain() ? '/' : localDeploymentProxyPath(args.localDeploymentId),
      FICUS_LOCAL_DEPLOYMENT_CWD: cwd,
      FICUS_LOCAL_DEPLOYMENT_DIR: dir,
      FICUS_LOCAL_DEPLOYMENT_COMMAND: args.command,
    }
    const launchCommand = [
      ...Object.entries(appEnv).map(([key, value]) => `${key}=${shellQuote(value)}`),
      `bash ${shellQuote(script)}`,
    ].join(' ')

    const command = [
      'set -e',
      `mkdir -p ${dir}/logs`,
      `cat > ${script} <<'EOF'\n${LAUNCHER_SCRIPT}EOF`,
      `chmod +x ${script}`,
      recordLaunchPathCommand(dir),
      `tmux kill-session -t ${shellQuote(processId)} 2>/dev/null || true`,
      `for _ in {1..20}; do tmux has-session -t ${shellQuote(processId)} 2>/dev/null || break; sleep 0.1; done`,
      `tmux new-session -d -s ${shellQuote(processId)} ${shellQuote(launchCommand)}`,
    ].join('\n')

    await this.manager.exec(args.sandboxId, ['bash', '-lc', command])
    return { processId }
  }

  async stopLocalDeployment(sandboxId: string, processId: string): Promise<void> {
    await this.manager.exec(sandboxId, ['bash', '-lc', `tmux kill-session -t ${shellQuote(processId)} || true`])
  }

  async hasSession(sandboxId: string, processId: string): Promise<boolean> {
    const status = await this.manager.execStatus(sandboxId, [
      'bash',
      '-lc',
      `tmux has-session -t ${shellQuote(processId)}`,
    ])
    return status === 0
  }

  streamLogs(
    sandboxId: string,
    localDeploymentId: string,
    tail: number,
    onLine: (line: string) => void,
    onError: (error: Error) => void = () => {}
  ): { cancel: () => void } {
    if (!this.manager.streamExec) throw new Error('Sandbox manager does not support streaming exec')

    const logFile = `${localDeploymentDir(sandboxId, localDeploymentId)}/logs/current.log`
    const command = [
      `mkdir -p ${shellQuote(localDeploymentDir(sandboxId, localDeploymentId) + '/logs')}`,
      `touch ${shellQuote(logFile)}`,
      `tail -n ${shellQuote(tail)} -F ${shellQuote(logFile)}`,
    ].join(' && ')
    let buffer = ''
    const flush = (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) onLine(line)
    }

    return this.manager.streamExec(sandboxId, ['bash', '-lc', command], flush, (chunk) =>
      onError(new Error(chunk.toString()))
    )
  }

  async tailLogs(sandboxId: string, localDeploymentId: string, tail: number): Promise<string[]> {
    const logFile = `${localDeploymentDir(sandboxId, localDeploymentId)}/logs/current.log`
    const exists = await this.manager.execStatus(sandboxId, ['bash', '-lc', `test -f ${shellQuote(logFile)}`])
    if (exists !== 0) {
      return []
    }

    const output = await this.manager.exec(sandboxId, [
      'bash',
      '-lc',
      `tail -n ${shellQuote(tail)} ${shellQuote(logFile)}`,
    ])
    return output
      .toString()
      .split('\n')
      .filter((line) => line.length > 0)
  }

  /**
   * Resolve an attached deployment's registered log path INSIDE its sandbox.
   * Follows symlinks when the runtime's tooling allows (realpath cascade) and
   * re-pins containment to the deployment's own squad workspace on EVERY read,
   * so a symlink created after registration cannot redirect the read outside.
   * Throws typed {@link LocalDeploymentLogPathOutsideWorkspaceError} on escape.
   */
  async resolveAttachedLogPath(sandboxId: string, logPath: string): Promise<{ resolved: string; exists: boolean }> {
    const squadId = sandboxId.replace(/^squad_/, '')
    const { workspaceMount } = resolveWorkspaceLayout({ squadId })
    const output = await this.manager.exec(sandboxId, [
      'bash',
      '-lc',
      buildResolveAttachedLogPathCommand(workspaceMount, logPath),
    ])
    if (output.toString().split('\n')[0] === 'OUTSIDE') {
      throw new LocalDeploymentLogPathOutsideWorkspaceError('Attached log path must stay inside the squad workspace')
    }
    return parseResolveAttachedLogPathOutput(output.toString())
  }

  /**
   * Bounded read of an attached deployment's log file. `unavailable` (not an
   * exception) when the file is missing or cannot be read — the route renders
   * a `[ficus]` notice for that instead of failing the request.
   */
  async tailAttachedLogs(
    sandboxId: string,
    logPath: string,
    tail: number
  ): Promise<{ kind: 'lines'; lines: string[] } | { kind: 'unavailable' }> {
    const { resolved, exists } = await this.resolveAttachedLogPath(sandboxId, logPath)
    if (!exists) return { kind: 'unavailable' }
    try {
      const output = await this.manager.exec(sandboxId, [
        'bash',
        '-lc',
        `tail -n ${shellQuote(tail)} ${shellQuote(resolved)}`,
      ])
      return {
        kind: 'lines',
        lines: output
          .toString()
          .split('\n')
          .filter((line) => line.length > 0),
      }
    } catch {
      return { kind: 'unavailable' } // e.g. unreadable; the notice explains instead of a raw 500
    }
  }

  /**
   * Live tail of an ALREADY-RESOLVED attached log path (call
   * {@link resolveAttachedLogPath} first): `tail -F` follows rotation/truncation
   * exactly like the managed stream, with an inline containment guard.
   */
  streamAttachedLogs(
    sandboxId: string,
    resolvedLogPath: string,
    tail: number,
    onLine: (line: string) => void,
    onError: (error: Error) => void = () => {}
  ): { cancel: () => void } {
    if (!this.manager.streamExec) throw new Error('Sandbox manager does not support streaming exec')

    const squadId = sandboxId.replace(/^squad_/, '')
    const { workspaceMount } = resolveWorkspaceLayout({ squadId })
    const command = buildStreamAttachedLogCommand(workspaceMount, resolvedLogPath, tail)
    let buffer = ''
    const flush = (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) onLine(line)
    }

    return this.manager.streamExec(sandboxId, ['bash', '-lc', command], flush, (chunk) =>
      onError(new Error(chunk.toString()))
    )
  }
}
