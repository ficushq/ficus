import { describe, expect, it, spyOn } from 'bun:test'
import { rmSync } from 'fs'
import { AgentSession } from './AgentSession'
import * as modelSelection from '../services/model-selection'
import * as authBackend from '../services/agent/auth-backend'
import * as modelSpec from '../lib/utils/model-spec'
import { getSessionDir } from '../lib/infra/session-files'
import * as workspaceLayoutModule from '../services/sandbox/workspace-layout'
import * as toolOutputRedaction from '../services/security/tool-output-redaction'
import * as toolFirewall from '../services/decisions/tool-firewall'

describe('AgentSession', () => {
  it('configures Pi to drain queued steers together and follow-ups one at a time', async () => {
    // Selection runs at create time; stub it to a configured single spec so the
    // test does not depend on real provider auth.
    const selSpy = spyOn(modelSelection, 'selectModelSpecForCurrentEnvWithSwitchBack').mockReturnValue({
      selected: 'anthropic:claude-sonnet-4-5',
      candidates: [
        { spec: 'anthropic:claude-sonnet-4-5', provider: 'anthropic', modelId: 'claude-sonnet-4-5', usable: true },
      ],
    })

    const session = await AgentSession.create({
      model: 'anthropic:claude-sonnet-4-5',
      systemPrompt: 'You are a test agent.',
    })

    expect(session.pi.steeringMode).toBe('all')
    expect(session.pi.followUpMode).toBe('one-at-a-time')
    selSpy.mockRestore()
  })

  it('selects the first usable model from a priority list at session creation', async () => {
    // Simulate a priority list where anthropic lacks auth and openai-codex is
    // usable — selection should resolve to openai-codex and feed only that
    // single spec into resolveAgentModelSpec.
    const selSpy = spyOn(modelSelection, 'selectModelSpecForCurrentEnvWithSwitchBack').mockReturnValue({
      selected: 'openai-codex:gpt-5.6-sol',
      candidates: [
        { spec: 'anthropic:claude-sonnet-4-5', provider: 'anthropic', usable: false, reason: 'auth-missing' },
        { spec: 'openai-codex:gpt-5.6-sol', provider: 'openai-codex', modelId: 'gpt-5.6-sol', usable: true },
      ],
    })
    // Call-through spy to capture which spec is resolved after selection.
    const resolveSpy = spyOn(modelSpec, 'resolveAgentModelSpec')

    await AgentSession.create({
      model: 'anthropic:claude-sonnet-4-5,openai-codex:gpt-5.6-sol',
      systemPrompt: 'You are a test agent.',
    })

    expect(selSpy).toHaveBeenCalledWith('anthropic:claude-sonnet-4-5,openai-codex:gpt-5.6-sol', undefined)
    // The full priority list must NOT be passed to resolveAgentModelSpec — only
    // the single selected spec.
    expect(resolveSpy).toHaveBeenCalledWith('openai-codex:gpt-5.6-sol')
    expect(resolveSpy).toHaveBeenCalledTimes(1)

    selSpy.mockRestore()
    resolveSpy.mockRestore()
  })

  it('selects a dynamically registered local model at session creation', async () => {
    const localModel = {
      id: 'llama3.2:latest',
      provider: 'local-session-test',
      name: 'Local',
      api: 'openai-completions',
      baseUrl: 'http://localhost:8080/v1',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32768,
      maxTokens: 4096,
    } as any
    const runtime = {
      getProviders: () => [{ id: localModel.provider }],
      getModel: (provider: string, id: string) =>
        provider === localModel.provider && id === localModel.id ? localModel : undefined,
      hasConfiguredAuth: () => true,
    } as any
    const runtimeSpy = spyOn(authBackend, 'tryGetModelRuntime').mockReturnValue(runtime)
    try {
      const session = await AgentSession.create({ model: 'local-session-test:llama3.2:latest', systemPrompt: 'Test' })
      expect(session.pi.model?.provider).toBe('local-session-test')
      expect(session.pi.model?.id).toBe('llama3.2:latest')
    } finally {
      runtimeSpy.mockRestore()
    }
  })

  it('uses squad-namespaced cwd when sandbox.squadId is set', async () => {
    const selSpy = spyOn(modelSelection, 'selectModelSpecForCurrentEnvWithSwitchBack').mockReturnValue({
      selected: 'anthropic:claude-sonnet-4-5',
      candidates: [
        { spec: 'anthropic:claude-sonnet-4-5', provider: 'anthropic', modelId: 'claude-sonnet-4-5', usable: true },
      ],
    })

    const layoutSpy = spyOn(workspaceLayoutModule, 'resolveWorkspaceLayout').mockImplementation(
      (ctx?: { squadId?: string }) => ({
        workspaceMount: ctx?.squadId ? `/workspace/${ctx.squadId}` : '/workspace',
        memoryMount: ctx?.squadId ? `/memory/${ctx.squadId}` : '/memory',
        cwd: ctx?.squadId ? `/workspace/${ctx.squadId}` : '/workspace',
        privateMount: '/private',
      })
    )

    try {
      await AgentSession.create({
        model: 'anthropic:claude-sonnet-4-5',
        systemPrompt: 'You are a test agent.',
        sandbox: {
          sandboxId: 'test-sandbox',
          workspacePath: '/host/workspace',
          squadId: 'sq1',
        },
      })

      // resolveWorkspaceLayout must have been called with squadId: 'sq1' (cwd is private in Pi session)
      const cwdCall = layoutSpy.mock.calls.find((args) => (args[0] as any)?.squadId === 'sq1')
      expect(cwdCall).toBeDefined()
    } finally {
      selSpy.mockRestore()
      layoutSpy.mockRestore()
    }
  })

  it('passes the stored-tool-result callback into the tool output wrapper', async () => {
    const selSpy = spyOn(modelSelection, 'selectModelSpecForCurrentEnvWithSwitchBack').mockReturnValue({
      selected: 'anthropic:claude-sonnet-4-5',
      candidates: [
        { spec: 'anthropic:claude-sonnet-4-5', provider: 'anthropic', modelId: 'claude-sonnet-4-5', usable: true },
      ],
    })
    const wrapSpy = spyOn(toolOutputRedaction, 'wrapToolsWithOutputRedaction')
    const onStoredToolResult = async () => {}

    try {
      const session = await AgentSession.create({
        model: 'anthropic:claude-sonnet-4-5',
        systemPrompt: 'You are a test agent.',
        tools: {
          core: [
            {
              name: 'generated-tool',
              label: 'generated-tool',
              description: 'generated-tool',
              parameters: {} as never,
              execute: async () => ({ content: [] }),
            } as never,
          ],
        },
        onStoredToolResult,
      })

      // The runner's per-execution containment coordinator must receive every
      // post-execution stored-key observation; sessions created without one
      // (non-agent-execution callers) keep the current callback-less behavior.
      expect(wrapSpy).toHaveBeenCalled()
      expect(wrapSpy.mock.calls.some((call) => call[2] === onStoredToolResult)).toBe(true)
      session.dispose()
    } finally {
      wrapSpy.mockRestore()
      selSpy.mockRestore()
    }
  })

  it('screens tool results with the firewall after redaction, for the session’s agent', async () => {
    const selSpy = spyOn(modelSelection, 'selectModelSpecForCurrentEnvWithSwitchBack').mockReturnValue({
      selected: 'anthropic:claude-sonnet-4-5',
      candidates: [
        { spec: 'anthropic:claude-sonnet-4-5', provider: 'anthropic', modelId: 'claude-sonnet-4-5', usable: true },
      ],
    })
    const redactSpy = spyOn(toolOutputRedaction, 'wrapToolsWithOutputRedaction')
    const firewallSpy = spyOn(toolFirewall, 'wrapToolsWithFirewall')
    const tool = (name: string) =>
      ({
        name,
        label: name,
        description: name,
        parameters: {} as never,
        execute: async () => ({ content: [] }),
      }) as never

    try {
      const session = await AgentSession.create({
        model: 'anthropic:claude-sonnet-4-5',
        systemPrompt: 'You are a test agent.',
        tools: { core: [tool('webfetch'), tool('bash'), tool('read')] },
      })

      // The decision model must only ever see content with stored secrets already redacted.
      expect(firewallSpy).toHaveBeenCalledTimes(1)
      expect(firewallSpy.mock.calls[0]![0]).toBe(redactSpy.mock.results[0]!.value as never)
      expect(firewallSpy.mock.calls[0]![1]).toEqual({ agentId: undefined })
      // Web tools and the shell (for commands that fetch) are screened; other tools are left as they are.
      const redacted = redactSpy.mock.results[0]!.value as Array<{ name: string }>
      const screened = firewallSpy.mock.results[0]!.value as Array<{ name: string }>
      expect(screened.map((entry) => entry.name)).toEqual(['webfetch', 'bash', 'read'])
      expect(screened[0]).not.toBe(redacted[0])
      expect(screened[1]).not.toBe(redacted[1])
      expect(screened[2]).toBe(redacted[2])
      session.dispose()
    } finally {
      firewallSpy.mockRestore()
      redactSpy.mockRestore()
      selSpy.mockRestore()
    }
  })

  it('exposes the Pi agent beforeToolCall hook target for stored-secret containment', async () => {
    const selSpy = spyOn(modelSelection, 'selectModelSpecForCurrentEnvWithSwitchBack').mockReturnValue({
      selected: 'anthropic:claude-sonnet-4-5',
      candidates: [
        { spec: 'anthropic:claude-sonnet-4-5', provider: 'anthropic', modelId: 'claude-sonnet-4-5', usable: true },
      ],
    })

    try {
      const session = await AgentSession.create({
        model: 'anthropic:claude-sonnet-4-5',
        systemPrompt: 'You are a test agent.',
      })

      // The runner wraps exactly this surface in agent-runners/base.ts run();
      // a Pi upgrade renaming or dropping it would silently degrade
      // pre-execution denial to the log.warn fallback. This tripwire catches
      // that against the real pinned coding-agent artifact, not a mock.
      const agent = (session.pi as unknown as { agent?: { beforeToolCall?: unknown } }).agent
      expect(agent).toBeDefined()
      expect(typeof agent!.beforeToolCall).toBe('function')
      session.dispose()
    } finally {
      selSpy.mockRestore()
    }
  })

  it('attaches precompaction for a stored session but skips it when precompaction:false', async () => {
    const selSpy = spyOn(modelSelection, 'selectModelSpecForCurrentEnvWithSwitchBack').mockReturnValue({
      selected: 'anthropic:claude-sonnet-4-5',
      candidates: [
        { spec: 'anthropic:claude-sonnet-4-5', provider: 'anthropic', modelId: 'claude-sonnet-4-5', usable: true },
      ],
    })
    const agentId = crypto.randomUUID()

    try {
      // Default: a stored session wires the background precompaction controller.
      const enabled = await AgentSession.create({
        model: 'anthropic:claude-sonnet-4-5',
        systemPrompt: ' ',
        storage: { agentId },
      })
      expect(enabled.precompaction).toBeDefined()
      enabled.dispose()

      // Opt-out: a throwaway compaction session must not wire precompaction, so
      // creating it can never spuriously start/abort a background bake.
      const disabled = await AgentSession.create({
        model: 'anthropic:claude-sonnet-4-5',
        systemPrompt: ' ',
        storage: { agentId },
        precompaction: false,
      })
      expect(disabled.precompaction).toBeUndefined()
      disabled.dispose()
    } finally {
      rmSync(getSessionDir(agentId), { recursive: true, force: true })
      selSpy.mockRestore()
    }
  })
})
