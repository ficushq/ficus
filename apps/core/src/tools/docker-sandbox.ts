import { consultantSandboxSquadId } from '../services/sandbox/consultant-sandbox'
import { resolveAgentBashCwd } from './k8s-sandbox'
/**
 * Docker Sandbox Tools
 *
 * Provides sandboxed versions of the coding tools (read, write, edit, bash)
 * that execute entirely inside a Docker container via DockerSandboxManager.
 *
 * All file operations (read, write, edit) and bash commands run inside
 * the container. The host never touches workspace files directly.
 */

import type { AgentTool } from '@earendil-works/pi-agent-core'
import { resolveWorkspaceLayout } from '../services/sandbox/workspace-layout'
import type { SandboxedToolWithKey } from '../services/sandbox/types'
import { getSandboxManager } from '../services/sandbox'
import type { DockerSandboxManager } from '../services/sandbox/docker/manager'
import { createK8sSandboxedBashTool, enforceAbsolutePaths } from './k8s-sandbox'
import { writeDockerFile } from './docker-tool-boundary'
import { detectReadImageMimeType, IMAGE_SNIFF_BYTES } from './read-image-mime'

export type { SandboxedToolWithKey } from '../services/sandbox/types'

function getDockerManager(): DockerSandboxManager {
  return getSandboxManager() as DockerSandboxManager
}

import { createReadTool, createWriteTool, createEditTool, type ReadOperations } from '@earendil-works/pi-coding-agent'

type WriteOperations = {
  writeFile: (absolutePath: string, content: string) => Promise<void>
  mkdir: (dir: string) => Promise<void>
}

type EditOperations = {
  readFile: (absolutePath: string) => Promise<Buffer>
  writeFile: (absolutePath: string, content: string) => Promise<void>
  access: (absolutePath: string) => Promise<void>
}

function createDockerReadOperations(sandboxId: string): ReadOperations {
  return {
    detectImageMimeType: async (absolutePath) =>
      detectReadImageMimeType(
        await getDockerManager().exec(sandboxId, ['head', '-c', String(IMAGE_SNIFF_BYTES), absolutePath])
      ),
    readFile: async (absolutePath: string): Promise<Buffer> => {
      return await getDockerManager().exec(sandboxId, ['cat', absolutePath])
    },
    access: async (absolutePath: string): Promise<void> => {
      const exitCode = await getDockerManager().execStatus(sandboxId, ['test', '-e', absolutePath])
      if (exitCode !== 0) {
        throw new Error(`ENOENT: no such file or directory, access '${absolutePath}'`)
      }
    },
  }
}

export function createDockerWriteOperations(sandboxId: string): WriteOperations {
  return {
    writeFile: async (absolutePath: string, content: string): Promise<void> => {
      await writeDockerFile(getDockerManager(), sandboxId, absolutePath, content)
    },
    mkdir: async (dir: string): Promise<void> => {
      await getDockerManager().exec(sandboxId, ['mkdir', '-p', dir])
    },
  }
}

function createDockerEditOperations(sandboxId: string): EditOperations {
  const readOps = createDockerReadOperations(sandboxId)
  const writeOps = createDockerWriteOperations(sandboxId)
  return {
    readFile: readOps.readFile,
    writeFile: writeOps.writeFile,
    access: readOps.access,
  }
}

export function createDockerSandboxedReadTool(cwd: string, sandboxId: string): AgentTool<any> {
  return createReadTool(cwd, {
    operations: createDockerReadOperations(sandboxId),
  })
}

export function createDockerSandboxedWriteTool(cwd: string, sandboxId: string): AgentTool<any> {
  return createWriteTool(cwd, {
    operations: createDockerWriteOperations(sandboxId),
  })
}

export function createDockerSandboxedEditTool(cwd: string, sandboxId: string): AgentTool<any> {
  return createEditTool(cwd, {
    operations: createDockerEditOperations(sandboxId),
  })
}

export function createDockerSandboxedBashTool(
  cwd: string,
  workspacePath: string,
  sandboxId: string,
  ficusToken?: string
): AgentTool<any> {
  const manager = getDockerManager()
  if (!manager.getClientForSandbox(sandboxId)) {
    throw new Error(`No sandbox executor found for ${sandboxId}. Ensure ensureSandbox() was called.`)
  }
  return createK8sSandboxedBashTool(cwd, sandboxId, manager, ficusToken)
}

/** Canonical keys for sandboxed tools; use these in agent type YAML tools.allow / tools.deny. */
export const DOCKER_SANDBOXED_TOOL_KEYS = ['Read', 'Write', 'Edit', 'Bash'] as const

/**
 * Creates all Docker-sandboxed coding tools for a workspace.
 * Each tool has a stable `key` (Read, Write, Edit, Bash) for filtering by agent type.
 */
export function createDockerSandboxedCodingTools(
  workspacePath: string,
  sandboxId: string,
  ficusToken?: string,
  squadId?: string,
  invocationOwnerId?: string,
  agentId?: string
): SandboxedToolWithKey[] {
  // read/write/edit take absolute paths (cwd-independent). The docker bash exec cwd
  // is controlled by the spawn hook's -w (the container workspaceMount), so it is
  // left unchanged here.
  const { workspaceMount } = resolveWorkspaceLayout({ squadId })
  const read = enforceAbsolutePaths(createDockerSandboxedReadTool(workspaceMount, sandboxId), workspaceMount)
  const write = enforceAbsolutePaths(createDockerSandboxedWriteTool(workspaceMount, sandboxId), workspaceMount)
  const edit = enforceAbsolutePaths(createDockerSandboxedEditTool(workspaceMount, sandboxId), workspaceMount)
  const manager = getDockerManager()
  if (!manager.getClientForSandbox(sandboxId)) {
    throw new Error(`No sandbox executor found for ${sandboxId}. Ensure ensureSandbox() was called.`)
  }
  const bash = createK8sSandboxedBashTool(
    consultantSandboxSquadId(sandboxId) ? resolveAgentBashCwd(sandboxId, agentId) : workspaceMount,
    sandboxId,
    manager,
    ficusToken,
    { invocationOwnerId, agentId }
  )
  return [
    { ...read, key: 'read' },
    { ...write, key: 'write' },
    { ...edit, key: 'edit' },
    { ...bash, key: 'bash' },
  ]
}
