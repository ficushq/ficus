import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { userInfo } from 'os'
import { buildWorkspacePrompt } from './workspace-prompt'
import { boxUnixUser } from '../../services/machines/box-paths'

describe('buildWorkspacePrompt — solo agent', () => {
  it('describes /private as the working dir and claims no shared workspace', () => {
    const p = buildWorkspacePrompt({})
    expect(p).toContain('/private')
    expect(p).toContain('no shared squad workspace')
    // Solo agents have no /workspace mount and no squad_bash.
    expect(p).not.toContain('/workspace/')
    expect(p).not.toContain('squad_bash')
  })

  it('always includes the devbox guidance', () => {
    expect(buildWorkspacePrompt({})).toContain('devbox add')
  })
})

describe('buildWorkspacePrompt — sandbox outage guidance', () => {
  it('explains outage errors, automatic recovery notification, and staying productive meanwhile', () => {
    const p = buildWorkspacePrompt({})
    expect(p).toContain('## Sandbox Outages')
    expect(p).toContain('currently unavailable')
    expect(p).toContain('notified')
    expect(p).toContain('sandbox_status')
    // Non-sandbox tools keep working during an outage.
    expect(p.toLowerCase()).toContain('keep working')
  })

  it('is included for squad agents too', () => {
    const p = buildWorkspacePrompt({ squadId: 'S1', hasSquadBash: true })
    expect(p).toContain('sandbox_status')
  })

  it('states that browser tools also depend on the running sandbox', () => {
    const p = buildWorkspacePrompt({})
    expect(p).toContain('bash, file, and browser tools')
  })
})

describe('buildWorkspacePrompt — squad agent with squad_bash (manager/worker)', () => {
  const p = buildWorkspacePrompt({ squadId: 'S1', squadName: 'Acme', hasSquadBash: true })

  it('describes the namespaced shared workspace, /private, and both bash tools', () => {
    expect(p).toContain('/workspace/S1')
    expect(p).toContain('/private')
    expect(p).toContain('Acme')
    expect(p).toContain('squad_bash')
    expect(p).toContain('two bash tools')
    expect(p).toContain('cd /workspace/S1')
    expect(p).toContain('never into `/private`')
    expect(p).toContain('squad memory files at `/memory/S1`')
  })

  it('makes squad_bash the default for all project commands and reserves bash for private exceptions', () => {
    expect(p).toContain('Default to `squad_bash` for ALL repository and project commands')
    expect(p).toContain('exception-only')
    expect(p).toContain('sensitive material')
    expect(p).not.toContain('default to it for your work')
    expect(p).not.toContain('ONLY when a process, port, dev server, or installed tool must be SHARED')
  })

  it('directs reusable Devbox and fallback tool installs through squad_bash', () => {
    expect(p).toContain('Run project and reusable toolchain changes with `squad_bash`')
    expect(p).toContain('sudo apk add')
  })
})

describe('buildWorkspacePrompt — squad agent without squad_bash (restricted custom agent / squad subagent)', () => {
  const p = buildWorkspacePrompt({ squadId: 'S1', squadName: 'Acme', hasSquadBash: false })

  it('mentions the shared workspace + /private but offers a single bash, no squad_bash', () => {
    expect(p).toContain('/workspace/S1')
    expect(p).toContain('/private')
    expect(p).toContain('single `bash`')
    expect(p).toContain('cd /workspace/S1')
    expect(p).toContain('never into `/private`')
    expect(p).not.toContain('squad_bash')
  })
})

describe('buildWorkspacePrompt — exact squad shell capability', () => {
  it('does not advertise squad_bash when raw capability is removed from exact tool names', () => {
    const p = buildWorkspacePrompt({ squadId: 'S1', hasSquadBash: true, toolNames: ['bash', 'read'] })
    expect(p).not.toContain('squad_bash')
    expect(p).toContain('single `bash`')
  })

  it('describes squad_bash-only children without inventing a private bash', () => {
    const p = buildWorkspacePrompt({
      squadId: 'S1',
      hasSquadBash: true,
      sharesParentBox: true,
      toolNames: ['squad_bash'],
    })
    expect(p).toContain('**Your shared shell tool:**')
    expect(p).toContain('`squad_bash`')
    expect(p).not.toContain('**`bash`**')
    expect(p).not.toContain('private `bash`')
    expect(p).not.toContain('Both shell tools')
    expect(p).not.toContain('private Devbox')
  })
})

describe('buildWorkspacePrompt — sharesParentBox (subagent)', () => {
  it('describes only effective tools and omits unavailable shell/file guidance', () => {
    const p = buildWorkspacePrompt({ squadId: 'S1', sharesParentBox: true, toolNames: ['read'] })
    expect(p).toContain('`read`')
    expect(p).not.toContain('`bash`')
    expect(p).not.toContain('`write`')
    expect(p).not.toContain('`edit`')
    expect(p).not.toContain('Devbox')
  })

  it('does not call a parent-shared directory exclusive or recommend it for secrets', () => {
    const p = buildWorkspacePrompt({ sharesParentBox: true, toolNames: ['bash'] })
    expect(p).toContain('shared with your parent agent and sibling subagents')
    expect(p).not.toContain('no teammate can read it')
    expect(p).not.toContain('keys and secrets')
    expect(p).toContain('Do not treat it as a secret store')
  })

  it('warns that the private dir is shared with the parent and sibling subagents', () => {
    const p = buildWorkspacePrompt({ squadId: 'S1', hasSquadBash: false, sharesParentBox: true })
    expect(p.toLowerCase()).toContain('share this sandbox')
    expect(p).toContain('sibling subagents')
  })

  it('solo subagents do not claim shared-box wording when sharesParentBox is false', () => {
    const p = buildWorkspacePrompt({ sharesParentBox: false })
    expect(p).not.toContain('sibling subagents')
  })
})

describe('buildWorkspacePrompt — vm runtime (box-native paths)', () => {
  const home = (sandboxId: string) => `/home/${boxUnixUser(sandboxId)}`
  let prev: string | undefined
  beforeEach(() => {
    prev = process.env.FICUS_SANDBOX_RUNTIME
    process.env.FICUS_SANDBOX_RUNTIME = 'vm'
  })
  afterEach(() => {
    if (prev === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
    else process.env.FICUS_SANDBOX_RUNTIME = prev
  })

  it('squad agent: shows the squad box workspace + own box private dir, never container literals', () => {
    const p = buildWorkspacePrompt({ squadId: 'S1', squadName: 'Acme', sandboxId: 'agent_a1', hasSquadBash: true })
    expect(p).toContain(`${home('squad_S1')}/workspace`)
    expect(p).toContain(`${home('agent_a1')}/.private`)
    expect(p).toContain(`squad memory files at \`${home('squad_S1')}/memory\``)
    // No k8s/docker container-only mount literals anywhere in the prose.
    expect(p).not.toContain('`/private`')
    expect(p).not.toContain('/workspace/S1')
    expect(p).not.toContain('`/memory')
  })

  it('squad agent: does NOT claim bash reaches the shared workspace; shared execution goes through squad_bash', () => {
    const p = buildWorkspacePrompt({ squadId: 'S1', squadName: 'Acme', sandboxId: 'agent_a1', hasSquadBash: true })
    const workspace = `${home('squad_S1')}/workspace`
    // The container claim ("bash can read and write both ...") must be gone —
    // on vm the member box cannot see the squad box's home at all.
    expect(p).not.toContain('It can read and write both')
    expect(p).not.toContain(`cd ${workspace}`)
    expect(p).toContain(`CANNOT see \`${workspace}\``)
    // File tools DO reach the shared workspace by absolute path (routed).
    expect(p).toContain('routed to the shared squad box')
    // Shared execution (clone/build/dev servers) is pointed at squad_bash.
    expect(p).toMatch(/squad_bash/)
    expect(p).toContain(`Clone repositories ONLY into subdirectories of \`${workspace}\` via \`squad_bash\``)
  })

  it('squad agent without squad_bash: file tools reach the workspace but it cannot execute there', () => {
    const p = buildWorkspacePrompt({ squadId: 'S1', squadName: 'Acme', sandboxId: 'agent_a1', hasSquadBash: false })
    const workspace = `${home('squad_S1')}/workspace`
    expect(p).not.toContain('squad_bash')
    expect(p).not.toContain('can read and write both')
    expect(p).toContain(`CANNOT see \`${workspace}\``)
    expect(p).toContain('routed to the shared squad box')
    // Honest about the execution gap: no shared-runtime bash at all.
    expect(p.toLowerCase()).toContain('cannot execute commands')
  })

  it('solo agent: working dir is its own box ~/.private, no container literals', () => {
    const p = buildWorkspacePrompt({ sandboxId: 'agent_a1' })
    expect(p).toContain(`${home('agent_a1')}/.private`)
    expect(p).not.toContain('`/private`')
    expect(p).not.toContain('/workspace')
    expect(p).not.toContain('squad_bash')
  })

  it('keeps the Sandbox Outages guidance (vm boxes do go down)', () => {
    const p = buildWorkspacePrompt({ squadId: 'S1', sandboxId: 'agent_a1', hasSquadBash: true })
    expect(p).toContain('## Sandbox Outages')
    expect(p).toContain('sandbox_status')
  })

  it('subagent sharing its parent box warns about the parent box private dir', () => {
    const p = buildWorkspacePrompt({ squadId: 'S1', sandboxId: 'agent_parent', sharesParentBox: true })
    expect(p).toContain(`including \`${home('agent_parent')}/.private\``)
  })
})

describe('buildWorkspacePrompt — host runtime', () => {
  let prevRuntime: string | undefined
  let prevHome: string | undefined
  beforeEach(() => {
    prevRuntime = process.env.FICUS_SANDBOX_RUNTIME
    prevHome = process.env.HOME_DIR
    process.env.FICUS_SANDBOX_RUNTIME = 'host'
    process.env.HOME_DIR = '/tau-home'
  })
  afterEach(() => {
    if (prevRuntime === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
    else process.env.FICUS_SANDBOX_RUNTIME = prevRuntime
    if (prevHome === undefined) delete process.env.HOME_DIR
    else process.env.HOME_DIR = prevHome
  })

  it('shows host storage paths and says bash reaches both areas', () => {
    const p = buildWorkspacePrompt({ squadId: 'S1', squadName: 'Acme', sandboxId: 'agent_a1', hasSquadBash: true })
    expect(p).toContain('/tau-home/private/agent_a1')
    expect(p).toContain('/tau-home/workspaces/squads/S1')
    expect(p).toContain('can read and write both')
    expect(p).not.toContain('/workspace/S1')
  })

  it('replaces the devbox section with the host section', () => {
    const p = buildWorkspacePrompt({ squadId: 'S1', sandboxId: 'agent_a1' })
    expect(p).toContain('## Host runtime')
    expect(p).toContain(`as user \`${userInfo().username}\``)
    expect(p).toContain('no sandbox or isolation')
    expect(p).not.toContain('devbox add')
    expect(p).not.toContain('sudo apk add')
    expect(p).not.toContain('Installing Tools with Devbox')
  })

  it('omits the host section when the agent has no shell tool', () => {
    const p = buildWorkspacePrompt({ squadId: 'S1', sandboxId: 'agent_a1', toolNames: ['read'] })
    expect(p).not.toContain('## Host runtime')
  })

  it('says tools run directly on the host, never "inside authorized sandboxes"', () => {
    const p = buildWorkspacePrompt({ squadId: 'S1', sandboxId: 'agent_a1', hasSquadBash: true })
    expect(p).toContain('directly on the Ficus host machine')
    expect(p).not.toContain('authorized sandboxes')
  })

  it('omits the Sandbox Outages section (there is no sandbox to go down)', () => {
    const p = buildWorkspacePrompt({ squadId: 'S1', sandboxId: 'agent_a1', hasSquadBash: true })
    expect(p).not.toContain('## Sandbox Outages')
    expect(p).not.toContain('sandbox_status')
  })
})
