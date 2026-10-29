import '../../test-utils/require-test-db'
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { existsSync } from 'fs'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const originalHomeDir = process.env.HOME_DIR
let tempHomeDir: string

beforeEach(async () => {
  tempHomeDir = await mkdtemp(join(tmpdir(), 'artifact-storage-path-test-'))
  process.env.HOME_DIR = tempHomeDir
})

afterEach(async () => {
  if (originalHomeDir === undefined) {
    delete process.env.HOME_DIR
  } else {
    process.env.HOME_DIR = originalHomeDir
  }

  clearSandboxPathModuleCache()

  if (tempHomeDir) {
    await rm(tempHomeDir, { recursive: true, force: true })
  }
})

function clearSandboxPathModuleCache() {
  delete require.cache[require.resolve('../sandbox/ensure')]
  delete require.cache[require.resolve('../sandbox/factory')]
  delete require.cache[require.resolve('../sandbox/workspace')]
  delete require.cache[require.resolve('../../lib/utils/home')]
}

async function getModules() {
  clearSandboxPathModuleCache()

  const sandboxFactory = await import('../sandbox/factory')
  const { getWorkspacePath } = await import('../sandbox/workspace')
  const { getAgentWorkspaceStoragePath } = await import('../sandbox/ensure')

  return { sandboxFactory, getWorkspacePath, getAgentWorkspaceStoragePath }
}

describe('artifact backend workspace storage paths', () => {
  test('uses HOME_DIR-based backend storage path in k8s instead of container /workspace', async () => {
    const { sandboxFactory, getWorkspacePath, getAgentWorkspaceStoragePath } = await getModules()
    const spy = spyOn(sandboxFactory, 'isK8sRuntime').mockReturnValue(true)

    try {
      const workspaceId = 'agent_artifact-builder-default_123'
      const storagePath = getAgentWorkspaceStoragePath(workspaceId)
      expect(storagePath).toBe(join(tempHomeDir, 'workspaces', 'agents', workspaceId))
      expect(storagePath).not.toBe('/workspace')
      expect(storagePath).not.toBe(getWorkspacePath(workspaceId))
      expect(existsSync(storagePath)).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  test('uses local host workspace path outside k8s', async () => {
    const { sandboxFactory, getWorkspacePath, getAgentWorkspaceStoragePath } = await getModules()
    const spy = spyOn(sandboxFactory, 'isK8sRuntime').mockReturnValue(false)

    try {
      const workspaceId = 'agent_local_123'
      expect(getAgentWorkspaceStoragePath(workspaceId)).toBe(getWorkspacePath(workspaceId))
    } finally {
      spy.mockRestore()
    }
  })
})
