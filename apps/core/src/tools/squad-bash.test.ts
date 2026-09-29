// apps/core/src/tools/squad-bash.test.ts
import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { join } from 'path'
import { createSquadBashTool as buildSquadBashTool, SQUAD_BASH_TOOL_KEY } from './squad-bash'

const fakeBashTool = () => ({ name: 'bash', label: 'bash', description: 'orig' }) as any

const factory = { isRemoteSandboxRuntime: () => false, getSandboxManager: (): any => ({}) }
const dockerTools = { createDockerSandboxedBashTool: fakeBashTool }
const hostTools = { createHostBashTool: fakeBashTool }
const k8sTools = { createK8sSandboxedBashTool: fakeBashTool }
function createSquadBashTool(...args: Parameters<typeof buildSquadBashTool>) {
  return buildSquadBashTool(args[0], args[1], args[2], args[3], args[4], args[5], {
    ...factory,
    ...dockerTools,
    ...hostTools,
    ...k8sTools,
  })
}

describe('createSquadBashTool', () => {
  const spies: Array<{ mockRestore: () => void }> = []
  afterEach(() => {
    spies.forEach((s) => s.mockRestore())
    spies.length = 0
  })

  it('builds the Docker bash tool bound to the warm box and renames it to squad_bash', () => {
    spies.push(spyOn(factory, 'isRemoteSandboxRuntime').mockReturnValue(false))
    const docker = spyOn(dockerTools, 'createDockerSandboxedBashTool').mockImplementation(fakeBashTool)
    spies.push(docker)

    const tool = createSquadBashTool('squad_S1', '/host/squads/S1', 'S1', 'ficus_agent_tok')

    // cwd + host workspace path are the squad host dir; sandboxId is the warm box; token threaded
    expect(docker).toHaveBeenCalledWith('/host/squads/S1', '/host/squads/S1', 'squad_S1', 'ficus_agent_tok')
    expect(tool.name).toBe(SQUAD_BASH_TOOL_KEY)
    expect(tool.label).toBe(SQUAD_BASH_TOOL_KEY)
    expect(tool.key).toBe(SQUAD_BASH_TOOL_KEY)
    expect(tool.description).toContain('default')
    expect(tool.description).toContain('repository')
    expect(tool.description).toContain('Docker')
    expect(tool.description).toContain('devbox add')
    expect(tool.description).not.toContain('work there by default')
    expect(tool.description).not.toContain('only when the runtime must be shared')
  })

  it('builds the K8s bash tool bound to the warm box when running on k8s', () => {
    spies.push(spyOn(factory, 'isRemoteSandboxRuntime').mockReturnValue(true))
    const fakeManager = { kind: 'k8s' } as any
    spies.push(spyOn(factory, 'getSandboxManager').mockReturnValue(fakeManager))
    const k8s = spyOn(k8sTools, 'createK8sSandboxedBashTool').mockImplementation(fakeBashTool)
    spies.push(k8s)

    const tool = createSquadBashTool('squad_S2', '/workspace', 'S2', undefined)

    expect(k8s).toHaveBeenCalledWith('/workspace/S2', 'squad_S2', fakeManager, undefined, {
      agentId: undefined,
      invocationOwnerId: undefined,
    })
    expect(tool.name).toBe(SQUAD_BASH_TOOL_KEY)
    expect(tool.key).toBe(SQUAD_BASH_TOOL_KEY)
  })

  it('threads the calling agent id through to the K8s bash tool for outage watch registration', () => {
    spies.push(spyOn(factory, 'isRemoteSandboxRuntime').mockReturnValue(true))
    const fakeManager = { kind: 'k8s' } as any
    spies.push(spyOn(factory, 'getSandboxManager').mockReturnValue(fakeManager))
    const k8s = spyOn(k8sTools, 'createK8sSandboxedBashTool').mockImplementation(fakeBashTool)
    spies.push(k8s)

    createSquadBashTool('squad_S2', '/workspace', 'S2', 'tok', 'agent-9')

    expect(k8s).toHaveBeenCalledWith('/workspace/S2', 'squad_S2', fakeManager, 'tok', {
      agentId: 'agent-9',
      invocationOwnerId: undefined,
    })
  })

  it('threads execution ownership independently from outage watch ownership', () => {
    spies.push(spyOn(factory, 'isRemoteSandboxRuntime').mockReturnValue(true))
    const fakeManager = { kind: 'k8s' } as any
    spies.push(spyOn(factory, 'getSandboxManager').mockReturnValue(fakeManager))
    const k8s = spyOn(k8sTools, 'createK8sSandboxedBashTool').mockImplementation(fakeBashTool)
    spies.push(k8s)

    createSquadBashTool('squad_S2', '/workspace', 'S2', 'tok', 'agent-9', 'execution-4')

    expect(k8s).toHaveBeenCalledWith('/workspace/S2', 'squad_S2', fakeManager, 'tok', {
      agentId: 'agent-9',
      invocationOwnerId: 'execution-4',
    })
  })

  it('(vm runtime) builds the client-based bash tool bound to the warm box', () => {
    // vm is a remote runtime, so squad_bash must reach the box over the manager's
    // client (the k8s-style tool) — NOT the docker host-path branch.
    spies.push(spyOn(factory, 'isRemoteSandboxRuntime').mockReturnValue(true))
    const fakeVmManager = { kind: 'vm' } as any
    spies.push(spyOn(factory, 'getSandboxManager').mockReturnValue(fakeVmManager))
    const k8s = spyOn(k8sTools, 'createK8sSandboxedBashTool').mockImplementation(fakeBashTool)
    spies.push(k8s)
    const docker = spyOn(dockerTools, 'createDockerSandboxedBashTool').mockImplementation(fakeBashTool)
    spies.push(docker)

    const tool = createSquadBashTool('squad_S3', '/host/squads/S3', 'S3', 'tok', 'agent-vm')

    expect(k8s).toHaveBeenCalledWith('/workspace/S3', 'squad_S3', fakeVmManager, 'tok', {
      agentId: 'agent-vm',
      invocationOwnerId: undefined,
    })
    expect(docker).not.toHaveBeenCalled()
    expect(tool.name).toBe(SQUAD_BASH_TOOL_KEY)
    expect(tool.key).toBe(SQUAD_BASH_TOOL_KEY)
  })

  it('(host runtime) builds the host bash tool bound to the shared squad workspace', () => {
    const prevRuntime = process.env.FICUS_SANDBOX_RUNTIME
    const prevHome = process.env.HOME_DIR
    process.env.FICUS_SANDBOX_RUNTIME = 'host'
    process.env.HOME_DIR = '/tmp/ficus-squad-bash-host-test'
    const host = spyOn(hostTools, 'createHostBashTool').mockImplementation(fakeBashTool)
    spies.push(host)
    try {
      const tool = createSquadBashTool('squad_S4', '/unused/host/path', 'S4', 'tok', 'agent-host')
      const expectedWorkspaceMount = join('/tmp/ficus-squad-bash-host-test', 'workspaces', 'squads', 'S4')

      // agentId is what pins the shell to this agent's own CLI auth store rather
      // than the operator's ~/.tau/cli/auth.json.
      expect(host).toHaveBeenCalledWith(expectedWorkspaceMount, {
        ficusToken: 'tok',
        squadId: 'S4',
        agentId: 'agent-host',
      })
      expect(tool.name).toBe(SQUAD_BASH_TOOL_KEY)
      expect(tool.key).toBe(SQUAD_BASH_TOOL_KEY)
      expect(tool.description).toContain('on this machine')
      expect(tool.description).toContain(expectedWorkspaceMount)
    } finally {
      if (prevRuntime === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
      else process.env.FICUS_SANDBOX_RUNTIME = prevRuntime
      if (prevHome === undefined) delete process.env.HOME_DIR
      else process.env.HOME_DIR = prevHome
    }
  })
})
