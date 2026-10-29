import { ToolFeedbackError } from './tool-feedback'
import { describe, it, expect, spyOn } from 'bun:test'
import {
  createDockerSandboxedBashTool,
  createDockerSandboxedCodingTools,
  createDockerWriteOperations,
  createDockerSandboxedReadTool,
} from './docker-sandbox'
import * as workspaceLayoutModule from '../services/sandbox/workspace-layout'
import * as sandboxModule from '../services/sandbox'

describe('docker-sandbox-tools', () => {
  const fakeWorkspace = '/tmp/sandbox-test-fake'

  it('writes only through the verified stdin execution boundary', async () => {
    const execWithStdin = async () => Buffer.from('')
    const stdinSpy = spyOn({ execWithStdin }, 'execWithStdin')
    const managerSpy = spyOn(sandboxModule, 'getSandboxManager').mockReturnValue({
      execWithStdin: stdinSpy,
      exec: () => {
        throw new Error('direct exec must not receive file contents')
      },
    } as any)
    try {
      await createDockerWriteOperations('sandbox').writeFile('/workspace/file', 'secret body')
      expect(stdinSpy).toHaveBeenCalledWith('sandbox', ['tee', '/workspace/file'], Buffer.from('secret body'))
    } finally {
      managerSpy.mockRestore()
    }
  })

  describe('createDockerSandboxedBashTool', () => {
    it('should throw without a sandbox container', () => {
      expect(() => createDockerSandboxedBashTool(fakeWorkspace, fakeWorkspace, 'nonexistent')).toThrow(
        /No sandbox executor found/
      )
    })
  })

  describe('createDockerSandboxedCodingTools', () => {
    it('should throw without a sandbox container', () => {
      expect(() => createDockerSandboxedCodingTools(fakeWorkspace, 'nonexistent')).toThrow(/No sandbox executor found/)
    })

    it('resolver seam: calls resolveWorkspaceLayout() for the Read/Write/Edit tool root cwd', () => {
      // This test proves the seam: createDockerSandboxedCodingTools must call
      // resolveWorkspaceLayout() to determine the container workspace path.
      // Before this change the factory read WORKSPACE_MOUNT directly (resolver
      // was never called); after the change the resolver is always consulted.
      const resolverSpy = spyOn(workspaceLayoutModule, 'resolveWorkspaceLayout')

      // Stub getSandboxManager so the bash tool does not throw (it normally
      // requires a live Docker container).
      const managerSpy = spyOn(sandboxModule, 'getSandboxManager').mockReturnValue({
        getClientForSandbox: () => ({}),
        getSandboxStatus: async () => ({ status: 'running' }),
      } as any)

      try {
        createDockerSandboxedCodingTools(fakeWorkspace, 'test-sandbox-seam')
        expect(resolverSpy).toHaveBeenCalled()
      } finally {
        resolverSpy.mockRestore()
        managerSpy.mockRestore()
      }
    })

    it('namespaced cwd root: passes squadId to resolveWorkspaceLayout when building squad tools', () => {
      const resolverSpy = spyOn(workspaceLayoutModule, 'resolveWorkspaceLayout')

      const managerSpy = spyOn(sandboxModule, 'getSandboxManager').mockReturnValue({
        getClientForSandbox: () => ({}),
        getSandboxStatus: async () => ({ status: 'running' }),
      } as any)

      try {
        createDockerSandboxedCodingTools(fakeWorkspace, 'squad_sq1', undefined, 'sq1')
        expect(resolverSpy).toHaveBeenCalledWith({ squadId: 'sq1' })
      } finally {
        resolverSpy.mockRestore()
        managerSpy.mockRestore()
      }
    })
  })
})

it('Docker missing-path feedback is typed but an executor failure is not', async () => {
  let exit = 1
  const manager = spyOn(sandboxModule, 'getSandboxManager').mockReturnValue({
    execStatus: async () => exit,
  } as unknown as ReturnType<typeof sandboxModule.getSandboxManager>)
  try {
    const tool = createDockerSandboxedReadTool('/workspace', 'fixture')
    const missing = await tool.execute('missing', { path: '/workspace/missing' }).catch((error) => error)
    expect(missing).toBeInstanceOf(ToolFeedbackError)
    exit = 127
    const broken = await tool.execute('broken', { path: '/workspace/missing' }).catch((error) => error)
    expect(broken).toBeInstanceOf(Error)
    expect(broken).not.toBeInstanceOf(ToolFeedbackError)
  } finally {
    manager.mockRestore()
  }
})
