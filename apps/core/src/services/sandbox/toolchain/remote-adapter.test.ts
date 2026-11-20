import { describe, expect, it } from 'bun:test'
import { SandboxHttpError, SandboxTransportError } from '../client/http-client'
import { reconcileRemoteToolchain } from './remote-adapter'
import { withNixCacheMaintenance } from '../../machines/nix-cache-maintenance'

function clientHarness(marker = '', activationFails: boolean | Error = false, activationGate?: Promise<void>) {
  const calls: string[] = []
  const activations: Array<{ active: boolean | undefined; fingerprint: string | undefined }> = []
  const client = {
    read: async ({ path }: { path: string }) => ({
      content: Buffer.from(path.endsWith('.ready') ? marker : '').toString('base64'),
    }),
    write: async ({ path }: { path: string }) => void calls.push(`write:${path.split('/').pop()}`),
    bash: ({ command }: { command: string }) => {
      calls.push(
        command.startsWith('rm ')
          ? command.includes('setup.sh')
            ? 'remove-setup'
            : 'clear-marker'
          : command.includes('devbox install')
            ? 'install'
            : command.includes('ntn --version')
              ? 'readiness'
              : 'setup'
      )
      const stream = new EventTarget() as any
      queueMicrotask(() => {
        stream.dispatchEvent(new MessageEvent('data', { data: { exitCode: 0 } }))
        stream.dispatchEvent(new Event('end'))
      })
      stream.on = (event: string, listener: (value?: unknown) => void) => {
        stream.addEventListener(event, (value: MessageEvent) => listener(value.data))
        return stream
      }
      stream.cancel = () => {}
      return stream
    },
    toolchainReady: async (active?: boolean, fingerprint?: string) => {
      calls.push('activate')
      activations.push({ active, fingerprint })
      await activationGate
      if (activationFails instanceof Error) throw activationFails
      if (activationFails) throw new Error('secret raw activation output')
    },
  }
  return { client: client as any, calls, activations }
}

describe('remote managed toolchain adapter', () => {
  it('skips progress for a current marker even while refreshing activation', async () => {
    const gate = Promise.withResolvers<void>()
    const { client, calls } = clientHarness('fingerprint', false, gate.promise)
    let tracked = 0
    const reconciliation = reconcileRemoteToolchain(
      client,
      '/toolchain',
      '/workspace',
      {
        config: { packages: ['a'] },
        fingerprint: 'fingerprint',
        devboxJson: '{}',
        reportStage: async () => {},
      },
      async (operation) => {
        tracked++
        return operation()
      }
    )
    await Bun.sleep(1)
    expect(calls).toEqual(['activate'])
    expect(tracked).toBe(0)
    gate.resolve()
    await expect(reconciliation).resolves.toBe('unchanged')
  })

  it('runs readiness even when the fingerprint marker is unchanged', async () => {
    const { client, calls } = clientHarness('fingerprint')
    expect(
      await reconcileRemoteToolchain(client, '/toolchain', '/workspace', {
        config: { packages: ['nodejs@24.12.0'] },
        fingerprint: 'fingerprint',
        devboxJson: '{}',
        readiness: [{ id: 'notion-cli', command: 'ntn --version', expectedSubstring: '0.23.25' }],
        reportStage: async () => {},
      })
    ).toBe('unchanged')
    expect(calls).toEqual(['readiness', 'activate'])
  })

  it('orders install, setup, activation, then marker inside reported mutation work', async () => {
    const { client, calls } = clientHarness()
    const stages: string[] = []
    const progress: string[] = []
    await reconcileRemoteToolchain(
      client,
      '/toolchain',
      '/workspace',
      {
        config: { packages: ['a'], setupScript: 'echo ready' },
        fingerprint: 'fingerprint',
        devboxJson: '{}',
        reportStage: async (stage) => void stages.push(stage),
      },
      async (operation) => {
        progress.push('started')
        const result = await operation()
        progress.push('finished')
        return result
      }
    )
    expect(stages).toEqual(['installing', 'running_setup'])
    expect(calls).toEqual([
      'clear-marker',
      'write:devbox.json',
      'write:setup.sh',
      // `rm -f devbox.lock`: an unpinned install always resolves afresh.
      'clear-marker',
      'install',
      'setup',
      'activate',
      'write:.ready',
    ])
    expect(progress).toEqual(['started', 'finished'])
  })

  it('removes an obsolete setup script when replacement omits it', async () => {
    const { client, calls } = clientHarness()
    await reconcileRemoteToolchain(client, '/toolchain', '/workspace', {
      config: { packages: ['a'] },
      fingerprint: 'fingerprint',
      devboxJson: '{}',
      reportStage: async () => {},
    })
    expect(calls).toContain('remove-setup')
    expect(calls).not.toContain('write:setup.sh')
  })

  it('reports failed mutation and does not write the marker when activation fails', async () => {
    const { client, calls } = clientHarness('', true)
    const progress: string[] = []
    await expect(
      reconcileRemoteToolchain(
        client,
        '/toolchain',
        '/workspace',
        {
          config: { packages: ['a'] },
          fingerprint: 'fingerprint',
          devboxJson: '{}',
          reportStage: async () => {},
        },
        async (operation) => {
          progress.push('started')
          try {
            return await operation()
          } catch (error) {
            progress.push('finished:failed')
            throw error
          }
        }
      )
    ).rejects.toMatchObject({ code: 'activation_failed' })
    expect(calls).not.toContain('write:.ready')
    expect(progress).toEqual(['started', 'finished:failed'])
  })

  const unchangedRequest = {
    config: { packages: ['a'] },
    fingerprint: 'fingerprint',
    devboxJson: '{}',
    reportStage: async () => {},
  }

  it('confirms an unchanged toolchain with its fingerprint so the box can answer from its cache', async () => {
    const { client, activations } = clientHarness('fingerprint')
    await expect(reconcileRemoteToolchain(client, '/toolchain', '/workspace', unchangedRequest)).resolves.toBe(
      'unchanged'
    )
    expect(activations).toEqual([{ active: true, fingerprint: 'fingerprint' }])
  })

  // An overloaded box made this call exceed its 30s budget, and the raw error
  // was recorded as an unknown provisioning failure with no logged cause.
  it('names an activation timeout on an unchanged toolchain instead of an unknown failure', async () => {
    for (const failure of [
      new SandboxTransportError('timeout', 'connect', new Error('The operation timed out.')),
      new SandboxHttpError('Managed toolchain activation timed out after 20s', 504, 'timeout'),
    ]) {
      const { client } = clientHarness('fingerprint', failure)
      const rejection = await reconcileRemoteToolchain(client, '/toolchain', '/workspace', unchangedRequest).catch(
        (error: unknown) => error
      )
      expect(rejection).toMatchObject({ code: 'timeout', cause: failure })
    }
  })

  it('classifies any other activation failure on an unchanged toolchain', async () => {
    const { client } = clientHarness('fingerprint', true)
    await expect(reconcileRemoteToolchain(client, '/toolchain', '/workspace', unchangedRequest)).rejects.toMatchObject({
      code: 'activation_failed',
    })
  })

  // An unpinned toolchain downloads a whole nixpkgs source tree into the box's
  // private Nix cache; the install must trigger the same compaction as seeding.
  it('runs Nix cache maintenance after the toolchain install', async () => {
    const { client } = clientHarness()
    const commands: string[] = []
    const bash = client.bash
    client.bash = (request: { command: string }) => {
      commands.push(request.command)
      return bash(request)
    }
    await reconcileRemoteToolchain(client, '/toolchain', '/workspace', {
      config: { packages: ['bun'] },
      fingerprint: 'fingerprint',
      devboxJson: '{}',
      reportStage: async () => {},
    })
    const install = commands.filter((command) => command.includes('devbox install'))
    expect(install).toEqual([withNixCacheMaintenance("devbox install -c '/toolchain'")])
    expect(install[0]).toContain('--prepare-nix-cache --keep-private-nix-objects')
  })

  describe('pinned devbox.lock', () => {
    // Simulates the box: devbox.lock is a file, `rm -f` removes it, and an
    // install without a lock resolves `fresh` while one with a lock keeps it.
    function pinHarness(options: { installExitCodes?: number[]; installError?: string; marker?: string } = {}) {
      const calls: string[] = []
      const files = new Map<string, string>()
      const exitCodes = [...(options.installExitCodes ?? [])]
      const recorded: Array<{ lock: string; unrealizable: boolean }> = []
      let loads = 0
      const client = {
        read: async ({ path }: { path: string }) => {
          if (path.endsWith('.ready')) return { content: Buffer.from(options.marker ?? '').toString('base64') }
          const content = files.get(path)
          if (content === undefined) throw new SandboxHttpError('not found', 404)
          return { content: Buffer.from(content).toString('base64') }
        },
        write: async ({ path, content }: { path: string; content: string }) => {
          calls.push(`write:${path.split('/').pop()}`)
          files.set(path, Buffer.from(content, 'base64').toString('utf8'))
        },
        bash: ({ command }: { command: string }) => {
          let exitCode = 0
          let error: string | undefined
          if (command.includes('devbox install')) {
            const pinned = files.has('/toolchain/devbox.lock')
            calls.push(pinned ? 'install:pinned' : 'install:fresh')
            exitCode = exitCodes.shift() ?? 0
            if (exitCode !== 0 && options.installError) error = options.installError
            if (exitCode === 0 && !pinned) files.set('/toolchain/devbox.lock', 'fresh')
          } else if (command.includes('devbox.lock')) {
            calls.push('remove-lock')
            files.delete('/toolchain/devbox.lock')
          } else if (command.startsWith('rm ')) {
            calls.push(command.includes('setup.sh') ? 'remove-setup' : 'clear-marker')
          } else {
            calls.push('setup')
            // A setup script that edits the lock must not change what is recorded.
            files.set('/toolchain/devbox.lock', 'edited-by-setup')
          }
          const stream = new EventTarget() as any
          queueMicrotask(() => {
            stream.dispatchEvent(new MessageEvent('data', { data: { exitCode, error } }))
            stream.dispatchEvent(new Event('end'))
          })
          stream.on = (event: string, listener: (value?: unknown) => void) => {
            stream.addEventListener(event, (value: MessageEvent) => listener(value.data))
            return stream
          }
          return stream
        },
        toolchainReady: async () => void calls.push('activate'),
      }
      const request = (pinnedLock: string | undefined, setupScript?: string) => ({
        config: { packages: ['bun'], ...(setupScript ? { setupScript } : {}) },
        fingerprint: 'fingerprint',
        devboxJson: '{}',
        reportStage: async () => {},
        loadPinnedLock: async () => {
          loads++
          return pinnedLock
        },
        recordResolvedLock: async (lock: string, outcome: { unrealizable: boolean }) =>
          void recorded.push({ lock, unrealizable: outcome.unrealizable }),
      })
      return { client: client as any, calls, files, recorded, request, loads: () => loads }
    }

    it('installs from the pin and records nothing', async () => {
      const h = pinHarness()
      await expect(reconcileRemoteToolchain(h.client, '/toolchain', '/workspace', h.request('pinned'))).resolves.toBe(
        'applied'
      )
      expect(h.calls).toEqual([
        'clear-marker',
        'write:devbox.json',
        'remove-setup',
        'write:devbox.lock',
        'install:pinned',
        'activate',
        'write:.ready',
      ])
      expect(h.files.get('/toolchain/devbox.lock')).toBe('pinned')
      expect(h.recorded).toEqual([])
    })

    it('resolves afresh without a leftover lock and records it before setup can edit it', async () => {
      const h = pinHarness()
      h.files.set('/toolchain/devbox.lock', 'planted')
      await reconcileRemoteToolchain(h.client, '/toolchain', '/workspace', h.request(undefined, 'echo setup'))
      expect(h.calls).toEqual([
        'clear-marker',
        'write:devbox.json',
        'write:setup.sh',
        'remove-lock',
        'install:fresh',
        'setup',
        'activate',
        'write:.ready',
      ])
      expect(h.recorded).toEqual([{ lock: 'fresh', unrealizable: false }])
    })

    it('falls back to a fresh resolution when the pin cannot be installed', async () => {
      const h = pinHarness({ installExitCodes: [1] })
      await expect(reconcileRemoteToolchain(h.client, '/toolchain', '/workspace', h.request('pinned'))).resolves.toBe(
        'applied'
      )
      expect(h.calls).toEqual([
        'clear-marker',
        'write:devbox.json',
        'remove-setup',
        'write:devbox.lock',
        'install:pinned',
        'remove-lock',
        'install:fresh',
        'activate',
        'write:.ready',
      ])
      expect(h.recorded).toEqual([{ lock: 'fresh', unrealizable: true }])
    })

    it('fails as before when the fresh resolution fails too, recording nothing', async () => {
      const h = pinHarness({ installExitCodes: [1, 1] })
      await expect(
        reconcileRemoteToolchain(h.client, '/toolchain', '/workspace', h.request('pinned'))
      ).rejects.toMatchObject({ code: 'install_failed' })
      expect(h.calls).not.toContain('write:.ready')
      expect(h.recorded).toEqual([])
    })

    it('does not retry a pinned install that timed out', async () => {
      const h = pinHarness({ installExitCodes: [124], installError: 'Command timed out' })
      await expect(
        reconcileRemoteToolchain(h.client, '/toolchain', '/workspace', h.request('pinned'))
      ).rejects.toMatchObject({ code: 'timeout' })
      expect(h.calls.filter((call) => call.startsWith('install'))).toEqual(['install:pinned'])
    })

    it('does not record a lock when activation fails after a fresh install', async () => {
      const h = pinHarness()
      h.client.toolchainReady = async () => {
        throw new Error('activation failed')
      }
      await expect(
        reconcileRemoteToolchain(h.client, '/toolchain', '/workspace', h.request(undefined))
      ).rejects.toMatchObject({ code: 'activation_failed' })
      expect(h.recorded).toEqual([])
    })

    it('keeps an applied toolchain when recording the lock fails', async () => {
      const h = pinHarness()
      const request = { ...h.request(undefined), recordResolvedLock: async () => Promise.reject(new Error('db down')) }
      await expect(reconcileRemoteToolchain(h.client, '/toolchain', '/workspace', request)).resolves.toBe('applied')
    })

    it('never loads the pin for an unchanged toolchain', async () => {
      const h = pinHarness({ marker: 'fingerprint' })
      await expect(reconcileRemoteToolchain(h.client, '/toolchain', '/workspace', h.request('pinned'))).resolves.toBe(
        'unchanged'
      )
      expect(h.loads()).toBe(0)
    })
  })
})
