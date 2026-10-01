import { describe, test, expect, spyOn } from 'bun:test'
import { createHash } from 'crypto'
import {
  SANDBOX_EXECUTOR_PROTOCOL_VERSION,
  buildSandboxPodSpec,
  getSandboxImage,
  getSandboxImagePullPolicy,
  reconcilableSpecHash,
  resolveEphemeralStorageLimit,
  resolveSandboxApiUrl,
  sandboxPodName,
  sandboxPodNames,
  sanitizeLabelValue,
  type BuildPodSpecInput,
  type SquadSandboxConfig,
} from './pod-spec'
import { getSandboxSkillsDir } from '../../agent/skill-materializer'
import { SANDBOX_IDENTITY_LEGACY, SANDBOX_IDENTITY_READ, SANDBOX_IDENTITY_WRITE } from '../identity-names'
import * as workspaceLayoutModule from '../workspace-layout'

/** Build a spec with the env seam stubbed out (no secret store / git identity). */
function buildSpec(input: Omit<BuildPodSpecInput, 'namespace'> & { namespace?: string }) {
  return buildSandboxPodSpec({ namespace: 'tau-sandboxes', ...input }, { buildEnv: () => [] })
}

describe('sandboxPodName', () => {
  test('sanitizes sandbox ID for K8s naming', () => {
    expect(sandboxPodName('squad_abc123')).toBe('ficus-sb-squad-abc123')
  })

  test('short names stay under 63 chars', () => {
    const name = sandboxPodName('manager_xyz')
    expect(name).toBe('ficus-sb-manager-xyz')
    expect(name.length).toBeLessThanOrEqual(63)
  })

  test('truncates and hashes long sandbox IDs to fit 63-char limit', () => {
    const longId = 'agent_system-manager_e8890566-3587-4d63-be1f-c474a06bc9f1'
    const name = sandboxPodName(longId)
    expect(name.length).toBeLessThanOrEqual(63)
    // Should end with a hash suffix
    expect(name).toMatch(/-[a-z0-9]{8}$/)
  })

  test('different long IDs produce different pod names', () => {
    const id1 = 'agent_system-manager_e8890566-3587-4d63-be1f-c474a06bc9f1'
    const id2 = 'agent_system-manager_f9990566-3587-4d63-be1f-c474a06bc9f2'
    expect(sandboxPodName(id1)).not.toBe(sandboxPodName(id2))
  })

  // I1 (fix round 1): a pod built under the legacy `tau-sb-` prefix must
  // still be found by name — sandboxPodNames (used by ensurePod's discovery
  // loop) must try it.
  test('accepts an explicit prefix, so a legacy-named pod can still be computed', () => {
    expect(sandboxPodName('squad_abc123', SANDBOX_IDENTITY_LEGACY.k8sPodNamePrefix)).toBe('tau-sb-squad-abc123')
  })
})

describe('sandboxPodNames', () => {
  test('lists the write name first, then every other read name', () => {
    const names = sandboxPodNames('squad_abc123')
    expect(names[0]).toBe('ficus-sb-squad-abc123')
    expect(names).toContain('tau-sb-squad-abc123')
    expect(names).toHaveLength(2)
  })
})

describe('sanitizeLabelValue', () => {
  test('keeps sandbox ID label values within Kubernetes length limits', () => {
    const longId = 'agent_artifact-builder-default_12f52dfb-d931-4fd1-a066-21a9c53ca9b8'
    const label = sanitizeLabelValue(longId)
    expect(label.length).toBeLessThanOrEqual(63)
    expect(label).toMatch(/^[a-z0-9]([-a-z0-9_.]*[a-z0-9])?$/)
    expect(label).toMatch(/-[a-z0-9]{8}$/)
  })

  test('different long sandbox IDs produce different label values', () => {
    const id1 = 'agent_artifact-builder-default_12f52dfb-d931-4fd1-a066-21a9c53ca9b8'
    const id2 = 'agent_artifact-builder-default_22f52dfb-d931-4fd1-a066-21a9c53ca9b9'
    expect(sanitizeLabelValue(id1)).not.toBe(sanitizeLabelValue(id2))
  })
})

describe('image and API URL resolution', () => {
  test('uses the compose registry image and Always pull policy for local k3d sandboxes', () => {
    expect(getSandboxImage({ isLocalDev: true, env: {} })).toBe('ficus-registry:5000/ficus-sandbox:latest')
    expect(getSandboxImagePullPolicy({ isLocalDev: true })).toBe('Always')
  })

  test('agent sandboxType selects the minimal agent image', () => {
    expect(getSandboxImage({ sandboxType: 'agent', isLocalDev: true, env: {} })).toBe(
      'ficus-registry:5000/ficus-sandbox-agent:latest'
    )
    expect(getSandboxImage({ sandboxType: 'agent', isLocalDev: false, env: {} })).toBe('ficus-sandbox-agent:latest')
    expect(
      getSandboxImage({ sandboxType: 'agent', isLocalDev: false, env: { FICUS_SANDBOX_AGENT_IMAGE: 'x/y:z' } })
    ).toBe('x/y:z')
    expect(getSandboxImage({ sandboxType: 'squad', isLocalDev: true, env: {} })).toBe(
      'ficus-registry:5000/ficus-sandbox:latest'
    )
  })

  // FICUS_K8S_* only applies to the k8s runtime, and the sandbox factory imports
  // every manager eagerly — so a stale FICUS_K8S_LOCAL=true left in a .env that
  // now says host/docker must not flip this module into local-k3d mode.
  test('the isLocalDev default follows the runtime, not a bare FICUS_K8S_LOCAL', () => {
    expect(getSandboxImage({ env: { FICUS_SANDBOX_RUNTIME: 'host', FICUS_K8S_LOCAL: 'true' } })).toBe(
      'ficus-sandbox:latest'
    )
    expect(
      getSandboxImage({
        sandboxType: 'agent',
        env: { FICUS_SANDBOX_RUNTIME: 'docker-socket', FICUS_K8S_LOCAL: 'true' },
      })
    ).toBe('ficus-sandbox-agent:latest')
    // Under the k8s runtime the key is honoured, as always.
    expect(getSandboxImage({ env: { FICUS_SANDBOX_RUNTIME: 'k8s', FICUS_K8S_LOCAL: 'true' } })).toBe(
      'ficus-registry:5000/ficus-sandbox:latest'
    )
    expect(getSandboxImage({ env: { FICUS_SANDBOX_RUNTIME: 'k8s' } })).toBe('ficus-sandbox:latest')
  })

  test('resolveSandboxApiUrl: local dev points at host.k3d.internal on the live port', () => {
    expect(resolveSandboxApiUrl('ficus-sandboxes', { isLocalDev: true, port: '62832' })).toBe(
      'http://host.k3d.internal:62832'
    )
    // Defaults to 3000 when no port is supplied.
    expect(resolveSandboxApiUrl('ficus-sandboxes', { isLocalDev: true, port: undefined })).toBe(
      'http://host.k3d.internal:3000'
    )
  })

  test('resolveSandboxApiUrl: cluster mode uses stable ficus-core Service DNS (port-independent)', () => {
    expect(resolveSandboxApiUrl('ficus-sandboxes', { isLocalDev: false, port: '62832' })).toBe(
      'http://ficus-api.ficus-core.svc.cluster.local:3000'
    )
    // Namespace suffix is preserved when mapping sandboxes -> core.
    expect(resolveSandboxApiUrl('ficus-sandboxes-dev', { isLocalDev: false })).toBe(
      'http://ficus-api.ficus-core-dev.svc.cluster.local:3000'
    )
  })
})

describe('resolveEphemeralStorageLimit', () => {
  test('uses a valid per-squad override', () => {
    expect(resolveEphemeralStorageLimit(25)).toBe('25Gi')
    expect(resolveEphemeralStorageLimit(1)).toBe('1Gi')
    expect(resolveEphemeralStorageLimit(200)).toBe('200Gi')
  })

  test('falls back to the default for an unset override', () => {
    // Default comes from the global env limit; just assert it's a valid Gi
    // quantity and not derived from the (absent) override.
    expect(resolveEphemeralStorageLimit(undefined)).toMatch(/Gi$/)
  })

  test('rejects out-of-range or non-integer overrides', () => {
    for (const bad of [0, -5, 1.5, 201, NaN]) {
      expect(resolveEphemeralStorageLimit(bad)).not.toBe(`${bad}Gi`)
      expect(resolveEphemeralStorageLimit(bad)).toMatch(/Gi$/)
    }
  })
})

describe('reconcilableSpecHash', () => {
  test('is stable for the same config and differs by storage limit', () => {
    expect(reconcilableSpecHash({ ephemeralStorageLimitGi: 25 })).toBe(
      reconcilableSpecHash({ ephemeralStorageLimitGi: 25 })
    )
    expect(reconcilableSpecHash({ ephemeralStorageLimitGi: 25 })).not.toBe(
      reconcilableSpecHash({ ephemeralStorageLimitGi: 50 })
    )
  })

  test('changes when the executor protocol changes so live pods are recreated', () => {
    expect(reconcilableSpecHash(undefined, 'write-verified-v1')).not.toBe(
      reconcilableSpecHash(undefined, 'legacy-without-write-verified')
    )
  })

  test('an unset override hashes the same as an out-of-range one (both fall back to default)', () => {
    expect(reconcilableSpecHash(undefined)).toBe(reconcilableSpecHash({ ephemeralStorageLimitGi: 0 }))
  })

  test('ignores non-reconcilable fields like alwaysOn / idleTimeout', () => {
    expect(reconcilableSpecHash({ ephemeralStorageLimitGi: 25, alwaysOn: true, idleTimeout: 1000 })).toBe(
      reconcilableSpecHash({ ephemeralStorageLimitGi: 25, alwaysOn: false, idleTimeout: 9999 })
    )
  })

  test('a pod stamped by a Core that predates the /usr/local/bin/ficus mount drifts (recreated when idle)', () => {
    // The hash a pre-ficus Core stamped on every pod it created: the same three fields, no CLI mount.
    // The CLI mount is immutable on a running pod, so a pod without the `ficus` mount must never be
    // adopted as current; the spec-drift path recreates it once it is idle.
    const preFicusStamp = (config?: SquadSandboxConfig) =>
      createHash('sha256')
        .update(
          JSON.stringify({
            executorProtocolVersion: SANDBOX_EXECUTOR_PROTOCOL_VERSION,
            ephemeralStorage: resolveEphemeralStorageLimit(config?.ephemeralStorageLimitGi),
            squadIds: config?.squadId ? [config.squadId] : [],
          })
        )
        .digest('hex')
        .slice(0, 16)
    for (const config of [
      undefined,
      { ephemeralStorageLimitGi: 25 },
      { squadId: '11111111-1111-4111-8111-111111111111', sandboxType: 'squad' as const },
    ]) {
      expect(reconcilableSpecHash(config)).not.toBe(preFicusStamp(config))
      expect(reconcilableSpecHash(config)).toBe(reconcilableSpecHash(config))
    }
  })

  test('differs by squadId — a solo box must not be adopted for a squad member (drives recreation)', () => {
    // squadId determines the squad-scoped mounts (/workspace/<id>, /memory/<id>),
    // immutable on a running pod. A solo box (no squadId) and a squad box must
    // hash differently so drift detection recreates rather than silently adopts.
    expect(reconcilableSpecHash({ squadId: '11111111-1111-4111-8111-111111111111' })).not.toBe(
      reconcilableSpecHash(undefined)
    )
    expect(reconcilableSpecHash({ squadId: '11111111-1111-4111-8111-111111111111' })).not.toBe(
      reconcilableSpecHash({ squadId: '22222222-2222-4222-8222-222222222222' })
    )
    // Stable for the same squad.
    expect(reconcilableSpecHash({ squadId: '11111111-1111-4111-8111-111111111111' })).toBe(
      reconcilableSpecHash({ squadId: '11111111-1111-4111-8111-111111111111' })
    )
  })
})

describe('buildSandboxPodSpec', () => {
  test('writes the write-set app label and spec-hash annotation only', async () => {
    const config = { sandboxType: 'squad' as const, ephemeralStorageLimitGi: 25 }
    const podSpec = await buildSpec({
      sandboxId: 'squad_11111111-1111-4111-8111-111111111111',
      podName: 'sb-squad-11111111-1111-4111-8111-111111111111',
      config,
    })
    const other = SANDBOX_IDENTITY_READ.find((set) => set !== SANDBOX_IDENTITY_WRITE)!
    expect(podSpec.metadata?.labels?.app).toBe(SANDBOX_IDENTITY_WRITE.k8sAppLabelValue)
    expect(podSpec.metadata?.annotations?.[SANDBOX_IDENTITY_WRITE.k8sSpecHashAnnotation]).toBe(
      reconcilableSpecHash(config)
    )
    expect(podSpec.metadata?.annotations?.[other.k8sSpecHashAnnotation]).toBeUndefined()
  })

  test('mounts the sandbox-auth secret at /etc/ficus and claims the ficus-core-data PVC', async () => {
    const podSpec = await buildSpec({
      sandboxId: 'squad_11111111-1111-4111-8111-111111111111',
      podName: 'tau-sb-squad-11111111-1111-4111-8111-111111111111',
      config: { sandboxType: 'squad' },
    })
    const container = podSpec.spec?.containers?.[0]
    expect(container?.volumeMounts).toContainEqual({ name: 'sandbox-auth', mountPath: '/etc/ficus', readOnly: true })
    expect(podSpec.spec?.volumes?.find((v: { name?: string }) => v.name === 'core-data')).toMatchObject({
      persistentVolumeClaim: { claimName: 'ficus-core-data' },
    })
    expect(podSpec.spec?.affinity?.podAffinity?.preferredDuringSchedulingIgnoredDuringExecution?.[0]).toMatchObject({
      podAffinityTerm: { labelSelector: { matchLabels: { app: 'ficus-core' } } },
    })
  })

  test('mounts staged CLI from core-data at the ficus executable path', async () => {
    const podSpec = await buildSpec({
      sandboxId: 'squad_11111111-1111-4111-8111-111111111111',
      podName: 'tau-sb-squad-11111111-1111-4111-8111-111111111111',
      config: { sandboxType: 'squad' },
    })
    const container = podSpec.spec?.containers?.[0]

    expect(container?.volumeMounts).toContainEqual({
      name: 'core-data',
      mountPath: '/usr/local/bin/ficus',
      subPath: 'cli/ficus.js',
      readOnly: true,
    })
    expect(podSpec.spec?.volumes?.filter((volume: { name?: string }) => volume.name === 'core-data')).toHaveLength(1)
  })

  test('the ficus mount is the only CLI on the PATH dirs, for squad, member and solo boxes', async () => {
    for (const input of [
      { sandboxId: 'squad_11111111-1111-4111-8111-111111111111', config: { sandboxType: 'squad' as const } },
      {
        sandboxId: 'agent_member',
        config: { sandboxType: 'agent' as const, squadId: '11111111-1111-4111-8111-111111111111' },
      },
      { sandboxId: 'agent_solo', config: { sandboxType: 'agent' as const, privateStorageKey: 'agent_solo' } },
    ]) {
      const podSpec = await buildSpec({ ...input, podName: `pod-${input.sandboxId.replace(/_/g, '-')}` })
      const onPath = (podSpec.spec?.containers?.[0]?.volumeMounts ?? []).filter((mount) =>
        /^\/usr\/(local\/)?s?bin\//.test(mount.mountPath)
      )
      expect(onPath).toEqual([
        { name: 'core-data', mountPath: '/usr/local/bin/ficus', subPath: 'cli/ficus.js', readOnly: true },
      ])
    }
  })

  test('mounts sandbox-scoped materialized skills from core-data', async () => {
    const podSpec = await buildSpec({
      sandboxId: 'squad_11111111-1111-4111-8111-111111111111',
      podName: 'tau-sb-squad-11111111-1111-4111-8111-111111111111',
      config: { sandboxType: 'squad' },
    })
    const container = podSpec.spec?.containers?.[0]

    expect(container?.volumeMounts).toContainEqual({
      name: 'core-data',
      mountPath: getSandboxSkillsDir('squad_11111111-1111-4111-8111-111111111111'),
      subPath: 'skills/sandboxes/squad-11111111-1111-4111-8111-111111111111',
      readOnly: true,
    })
  })

  test('sets ephemeral-storage request and limit so sandbox pods are not BestEffort for node disk', async () => {
    const podSpec = await buildSpec({
      sandboxId: 'squad_11111111-1111-4111-8111-111111111111',
      podName: 'tau-sb-squad-11111111-1111-4111-8111-111111111111',
      config: { sandboxType: 'squad' },
    })
    const resources = podSpec.spec?.containers?.[0]?.resources

    expect(resources?.requests).toMatchObject({
      cpu: '100m',
      memory: '256Mi',
      'ephemeral-storage': '10Gi',
    })
    expect(resources?.limits).toMatchObject({
      cpu: '2',
      'ephemeral-storage': '10Gi',
    })
  })

  // The CPU request is what the scheduler reserves for the pod's entire life,
  // so it alone decides how many sandboxes fit on a node; the limit only caps
  // bursting. Measured idle draw is 1m, so a request anywhere near the 2-core
  // limit prices every idle agent as though it were mid-turn — which is exactly
  // how a 14-core node hit its ceiling at 27 IDLE sandboxes and stranded 11
  // agents in Pending. Pin the gap so nobody "tidies" the request up toward the
  // limit; asserted as a ratio rather than a literal so the intent survives a
  // future retune of either value.
  test('reserves an order of magnitude less CPU than it allows, so idle sandboxes do not eat scheduling capacity', async () => {
    const podSpec = await buildSpec({
      sandboxId: 'squad_11111111-1111-4111-8111-111111111111',
      podName: 'tau-sb-squad-11111111-1111-4111-8111-111111111111',
      config: { sandboxType: 'squad' },
    })
    const resources = podSpec.spec?.containers?.[0]?.resources

    const toMillicores = (v: string) => (v.endsWith('m') ? Number(v.slice(0, -1)) : Number(v) * 1000)
    const request = toMillicores(String(resources?.requests?.cpu))
    const limit = toMillicores(String(resources?.limits?.cpu))

    expect(request).toBeLessThanOrEqual(limit / 10)
    // A 14-core node must fit far more than the ~28 the old 500m request allowed.
    expect(Math.floor(14_000 / request)).toBeGreaterThanOrEqual(100)
  })

  test('agent pods reserve a small slice of ephemeral-storage while keeping the configured limit', async () => {
    const podSpec = await buildSpec({
      sandboxId: 'agent_11111111-1111-4111-8111-111111111111',
      podName: 'tau-sb-agent-11111111-1111-4111-8111-111111111111',
      config: {
        sandboxType: 'agent',
        squadId: '11111111-1111-4111-8111-111111111111',
        privateStorageKey: 'agent_11111111-1111-4111-8111-111111111111',
        ephemeralStorageLimitGi: 25,
      },
    })
    const resources = podSpec.spec?.containers?.[0]?.resources

    expect(resources?.requests?.['ephemeral-storage']).toBe('256Mi')
    expect(resources?.limits?.['ephemeral-storage']).toBe('25Gi')
  })

  // The request is reserved for the pod's whole life and is what caps how many
  // agent sandboxes fit on a node; the limit only bounds blast radius. Measured
  // agent usage is a median of 0MiB (4.7MiB peak), so a request sized anywhere
  // near the limit strands agents in Pending on a node with idle CPU — which is
  // exactly what happened when 2Gi apiece pinned ephemeral at 97% while CPU sat
  // at 43%. Asserted as a ceiling rather than a literal so the intent survives a
  // retune of either number.
  test('an agent sandbox reserves little enough ephemeral-storage that a node fits well over 100 of them', async () => {
    const podSpec = await buildSpec({
      sandboxId: 'agent_11111111-1111-4111-8111-111111111111',
      podName: 'tau-sb-agent-11111111-1111-4111-8111-111111111111',
      config: {
        sandboxType: 'agent',
        squadId: '11111111-1111-4111-8111-111111111111',
        privateStorageKey: 'agent_11111111-1111-4111-8111-111111111111',
      },
    })
    const request = String(podSpec.spec?.containers?.[0]?.resources?.requests?.['ephemeral-storage'])

    const toMiB = (v: string) => (v.endsWith('Gi') ? Number(v.slice(0, -2)) * 1024 : Number(v.replace('Mi', '')))
    const requestMiB = toMiB(request)

    // 71.5GiB allocatable on the dev node; require room for >100 agent sandboxes.
    expect(Math.floor((71.5 * 1024) / requestMiB)).toBeGreaterThan(100)
  })

  test('squad pods keep their large ephemeral-storage request, which real usage justifies', async () => {
    const podSpec = await buildSpec({
      sandboxId: 'squad_11111111-1111-4111-8111-111111111111',
      podName: 'tau-sb-squad-11111111-1111-4111-8111-111111111111',
      config: { sandboxType: 'squad' },
    })

    // Measured 7.0GiB on the busiest dev squad — this one is calibrated, and the
    // agent-side reduction must not be applied to it.
    expect(podSpec.spec?.containers?.[0]?.resources?.requests?.['ephemeral-storage']).toBe('10Gi')
  })

  test('agent pods use a fast startup probe; squad pods keep the slow one', async () => {
    const agent = await buildSpec({
      sandboxId: 'agent_abc',
      podName: 'tau-sb-agent-abc',
      config: { sandboxType: 'agent', squadId: '11111111-1111-4111-8111-111111111111', privateStorageKey: 'agent_abc' },
    })
    const squad = await buildSpec({
      sandboxId: 'squad_11111111-1111-4111-8111-111111111111',
      podName: 'tau-sb-squad-11111111-1111-4111-8111-111111111111',
      config: { sandboxType: 'squad' },
    })
    const probe = (s: any) => s.spec.containers[0].startupProbe
    expect(probe(agent)).toMatchObject({ initialDelaySeconds: 1, periodSeconds: 2 })
    expect(probe(squad)).toMatchObject({ initialDelaySeconds: 5, periodSeconds: 5 })
  })

  test('agent pods set role/devbox-dir env and omit the nix-cache mount', async () => {
    const podSpec = await buildSpec({
      sandboxId: 'agent_abc',
      podName: 'tau-sb-agent-abc',
      config: { sandboxType: 'agent', squadId: '11111111-1111-4111-8111-111111111111', privateStorageKey: 'agent_abc' },
    })
    const c = podSpec.spec!.containers![0]
    const env = Object.fromEntries((c.env ?? []).map((e: any) => [e.name, e.value]))
    expect(env.FICUS_SANDBOX_ROLE).toBe('agent')
    expect(env.FICUS_DEVBOX_DIR).toBe('/private')
    expect(Object.keys(env).filter((name) => name.endsWith('_SANDBOX_ROLE'))).toEqual(['FICUS_SANDBOX_ROLE'])
    expect((c.volumeMounts ?? []).some((m: any) => m.mountPath === '/nix-cache')).toBe(false)
    // memory + ssh mounts remain for squad members
    expect((c.volumeMounts ?? []).some((m: any) => m.mountPath === '/var/lib/ficus/ssh-source')).toBe(true)
    // Squad members still mount the shared squad workspace + their own /private.
    expect(env.WORKSPACE_PATH).toBe('/workspace/11111111-1111-4111-8111-111111111111')
    expect(
      (c.volumeMounts ?? []).some((m: any) => m.mountPath === '/workspace/11111111-1111-4111-8111-111111111111')
    ).toBe(true)
    expect((c.volumeMounts ?? []).some((m: any) => m.mountPath === '/private')).toBe(true)
  })

  test('solo agent pods work in /private with no /workspace mount', async () => {
    const podSpec = await buildSpec({
      sandboxId: 'agent_solo1',
      podName: 'tau-sb-agent-solo1',
      config: { sandboxType: 'agent', privateStorageKey: 'agent_solo1' }, // no squadId → solo
    })
    const c = podSpec.spec!.containers![0]
    const env = Object.fromEntries((c.env ?? []).map((e: any) => [e.name, e.value]))
    // Solo agents work in /private — no /workspace at all.
    expect(env.WORKSPACE_PATH).toBe('/private')
    expect(env.FICUS_DEVBOX_DIR).toBe('/private')
    const mountPaths = (c.volumeMounts ?? []).map((m: any) => m.mountPath)
    expect(mountPaths).toContain('/private')
    expect(mountPaths.some((p: string) => p === '/workspace' || p.startsWith('/workspace/'))).toBe(false)
    // Solo agents are not squad members: no memory/ssh/nix-cache mounts.
    expect(mountPaths).not.toContain('/var/lib/ficus/ssh-source')
    expect(mountPaths).not.toContain('/nix-cache')
  })

  test('squad pods keep the nix-cache mount and squad role', async () => {
    const podSpec = await buildSpec({
      sandboxId: 'squad_11111111-1111-4111-8111-111111111111',
      podName: 'tau-sb-squad-11111111-1111-4111-8111-111111111111',
      config: { sandboxType: 'squad' },
    })
    const c = podSpec.spec!.containers![0]
    const env = Object.fromEntries((c.env ?? []).map((e: any) => [e.name, e.value]))
    expect(env.FICUS_SANDBOX_ROLE).toBe('squad')
    expect((c.volumeMounts ?? []).some((m: any) => m.mountPath === '/nix-cache')).toBe(true)
  })
})

describe('buildSandboxPodSpec workspace mount routing', () => {
  let capturedSquadId: string | undefined
  const buildEnv = ({ squadId }: { squadId: string }) => {
    capturedSquadId = squadId
    return []
  }
  const build = (sandboxId: string, podName: string, config: BuildPodSpecInput['config']) =>
    buildSandboxPodSpec({ sandboxId, podName, namespace: 'tau-sandboxes', config }, { buildEnv })

  test('workspace volumeMount.mountPath uses containerWorkspaceLayout().workspaceMount', async () => {
    const podSpec = await build(
      'squad_11111111-1111-4111-8111-111111111111',
      'tau-sb-squad-11111111-1111-4111-8111-111111111111',
      { sandboxType: 'squad' }
    )
    const container = podSpec.spec?.containers?.[0]
    const workspaceVolumeMount = container?.volumeMounts?.find(
      (m: any) => m.name === 'core-data' && typeof m.subPath === 'string' && m.subPath.startsWith('workspaces/')
    )
    expect(workspaceVolumeMount?.mountPath).toBe('/workspace/11111111-1111-4111-8111-111111111111')
  })

  test('workspace volumeMount.mountPath follows a custom containerWorkspaceLayout return value', async () => {
    const spy = spyOn(workspaceLayoutModule, 'containerWorkspaceLayout').mockReturnValue({
      workspaceMount: '/custom-mount',
      memoryMount: '/custom-mount',
      cwd: '/custom-mount',
      privateMount: '/private',
    })
    try {
      const podSpec = await build(
        'squad_11111111-1111-4111-8111-111111111111',
        'tau-sb-squad-11111111-1111-4111-8111-111111111111',
        { sandboxType: 'squad' }
      )
      const container = podSpec.spec?.containers?.[0]
      const workspaceVolumeMount = container?.volumeMounts?.find(
        (m: any) => m.name === 'core-data' && typeof m.subPath === 'string' && m.subPath.startsWith('workspaces/')
      )
      expect(workspaceVolumeMount?.mountPath).toBe('/custom-mount')
    } finally {
      spy.mockRestore()
    }
  })

  test('privateStorageKey mounts /private subPath from core-data PVC', async () => {
    const podSpec = await build('agent_xyz789', 'tau-sb-agent-xyz789', {
      sandboxType: 'agent',
      privateStorageKey: 'agent_w_2',
    })
    const container = podSpec.spec?.containers?.[0]
    expect(container?.volumeMounts).toContainEqual({
      name: 'core-data',
      mountPath: '/private',
      subPath: 'private/agent_w_2',
    })
  })

  test('agent with squadId mounts squad workspace/ssh but NOT memory or nix-cache', async () => {
    capturedSquadId = undefined
    const podSpec = await build('agent_xyz789', 'tau-sb-agent-xyz789', {
      sandboxType: 'agent',
      squadId: '11111111-1111-4111-8111-111111111111',
    })
    const container = podSpec.spec?.containers?.[0]
    const mounts = container?.volumeMounts ?? []

    // workspace subPath should use squad key
    const workspaceMount = mounts.find(
      (m: any) => m.name === 'core-data' && typeof m.subPath === 'string' && m.subPath.startsWith('workspaces/')
    )
    expect(workspaceMount?.subPath).toBe('workspaces/squads/11111111-1111-4111-8111-111111111111')
    expect(workspaceMount?.mountPath).toBe('/workspace/11111111-1111-4111-8111-111111111111')

    // WORKSPACE_PATH env var should reflect the namespaced mount
    const workspacePathEnv = container?.env?.find((e: any) => e.name === 'WORKSPACE_PATH')
    expect(workspacePathEnv?.value).toBe('/workspace/11111111-1111-4111-8111-111111111111')

    // Squad MEMBERS get NO /memory mount — deliberate (memory is core-side via
    // memory_* tools; members never had a memory replica on the vm transport).
    expect(mounts.some((m: any) => typeof m.subPath === 'string' && m.subPath.startsWith('memory/'))).toBe(false)

    // ssh-source mount keyed by squad key
    expect(mounts).toContainEqual({
      name: 'core-data',
      mountPath: '/var/lib/ficus/ssh-source',
      subPath: 'ssh/11111111-1111-4111-8111-111111111111',
    })

    // Agent (light) boxes are minimal: no shared nix-cache mount.
    expect(mounts.some((m: any) => m.mountPath === '/nix-cache')).toBe(false)

    // buildEnv receives the squadId so the pod gets the correct git identity
    expect(capturedSquadId!).toBe('11111111-1111-4111-8111-111111111111')
  })

  test('mounts the squad-member workspace at /workspace/<squadId> and sets WORKSPACE_PATH', async () => {
    const podSpec = await build('agent_x', 'tau-sb-agent-x', {
      sandboxType: 'agent',
      squadId: '11111111-1111-4111-8111-111111111111',
    })
    const ws = podSpec.spec!.containers![0].volumeMounts!.find(
      (m: any) => m.subPath === 'workspaces/squads/11111111-1111-4111-8111-111111111111'
    )
    expect(ws!.mountPath).toBe('/workspace/11111111-1111-4111-8111-111111111111')
    const env = podSpec.spec!.containers![0].env!.find((e: any) => e.name === 'WORKSPACE_PATH')
    expect(env!.value).toBe('/workspace/11111111-1111-4111-8111-111111111111')
  })

  test('solo agent (no squadId) has no /workspace mount and no /memory mount', async () => {
    capturedSquadId = undefined
    const podSpec = await build('agent_xyz789', 'tau-sb-agent-xyz789', { sandboxType: 'agent' })
    const container = podSpec.spec?.containers?.[0]
    const mounts = container?.volumeMounts ?? []

    // Solo agents work in /private (mounted when privateStorageKey is set);
    // they have no /workspace at all.
    const workspaceMount = mounts.find(
      (m: any) => m.name === 'core-data' && typeof m.subPath === 'string' && m.subPath.startsWith('workspaces/')
    )
    expect(workspaceMount).toBeUndefined()

    const memoryMount = mounts.find((m: any) => m.mountPath === '/memory')
    expect(memoryMount).toBeUndefined()

    // buildEnv receives empty string for solo agents (no squad identity)
    expect(capturedSquadId!).toBe('')
  })

  test('warm squad box (no squadId, no privateStorageKey) remains unchanged — workspace/memory present, no /private', async () => {
    capturedSquadId = undefined
    const podSpec = await build(
      'squad_11111111-1111-4111-8111-111111111111',
      'tau-sb-squad-11111111-1111-4111-8111-111111111111',
      { sandboxType: 'squad' }
    )
    const container = podSpec.spec?.containers?.[0]
    const mounts = container?.volumeMounts ?? []

    const workspaceMount = mounts.find(
      (m: any) => m.name === 'core-data' && typeof m.subPath === 'string' && m.subPath.startsWith('workspaces/')
    )
    expect(workspaceMount?.subPath).toBe('workspaces/squads/11111111-1111-4111-8111-111111111111')
    expect(workspaceMount?.mountPath).toBe('/workspace/11111111-1111-4111-8111-111111111111')

    // WORKSPACE_PATH env var should reflect the namespaced mount
    const workspacePathEnv = container?.env?.find((e: any) => e.name === 'WORKSPACE_PATH')
    expect(workspacePathEnv?.value).toBe('/workspace/11111111-1111-4111-8111-111111111111')

    expect(mounts).toContainEqual({
      name: 'core-data',
      mountPath: '/memory/11111111-1111-4111-8111-111111111111',
      subPath: 'memory/11111111-1111-4111-8111-111111111111',
      readOnly: true,
    })

    const privateMount = mounts.find((m: any) => m.mountPath === '/private')
    expect(privateMount).toBeUndefined()

    // buildEnv receives the squad key (squad ID stripped of prefix) so the warm
    // box gets the correct git identity
    expect(capturedSquadId!).toBe('11111111-1111-4111-8111-111111111111')
  })

  test('squad-member agent pod (squadId + privateStorageKey) has workspace and /private mounts but NOT /memory', async () => {
    capturedSquadId = undefined
    const podSpec = await build('agent_xyz789', 'tau-sb-agent-xyz789', {
      sandboxType: 'agent',
      squadId: '11111111-1111-4111-8111-111111111111',
      privateStorageKey: 'agent_w_2',
    })
    const container = podSpec.spec?.containers?.[0]
    const mounts = container?.volumeMounts ?? []

    // /workspace subPath uses squad key
    const workspaceVolumeMount = mounts.find(
      (m: any) => m.name === 'core-data' && typeof m.subPath === 'string' && m.subPath.startsWith('workspaces/')
    )
    expect(workspaceVolumeMount?.subPath).toBe('workspaces/squads/11111111-1111-4111-8111-111111111111')
    expect(workspaceVolumeMount?.mountPath).toBe('/workspace/11111111-1111-4111-8111-111111111111')

    // WORKSPACE_PATH env var should reflect the namespaced mount
    const workspacePathEnv = container?.env?.find((e: any) => e.name === 'WORKSPACE_PATH')
    expect(workspacePathEnv?.value).toBe('/workspace/11111111-1111-4111-8111-111111111111')

    // /private mount is read-write (no readOnly field)
    const privateMountEntry = mounts.find((m: any) => m.mountPath === '/private')
    expect(privateMountEntry).toBeDefined()
    expect(privateMountEntry?.subPath).toBe('private/agent_w_2')
    expect(privateMountEntry?.readOnly).toBeUndefined()

    // Squad MEMBERS get NO /memory mount — see the golden-master note below for
    // why (memory access is core-side via memory_* tools; members never had a
    // memory replica on the vm transport). This mount was dropped deliberately.
    expect(mounts.some((m: any) => typeof m.subPath === 'string' && m.subPath.startsWith('memory/'))).toBe(false)
  })
})

/**
 * GOLDEN MASTER — the exact set of per-ASSET subPath volumeMounts the pod-spec
 * emits (skills / memory / ssh), by role. These are HARDCODED literals (not
 * computed from resolveSandboxAssets) so they pin delivery against manifest
 * regressions. Working-volume mounts (workspace / private / cli / nix-cache /
 * docker / sandbox-auth) are deliberately EXCLUDED — they are out of scope and
 * stay hardcoded in pod-spec.
 *
 * DELIBERATE, USER-APPROVED BEHAVIOR CHANGE: a squad MEMBER (agent pod with a
 * squadId) gets skills + ssh but NO `/memory/<squadId>` mount. The pre-manifest
 * k8s code mounted squad memory read-only into member pods; that was over-broad
 * legacy with zero consumers — memory access is core-side via the memory_*
 * tools on EVERY runtime, and the vm transport never gave members a memory
 * replica (they function normally without one). Driving all three transports
 * from one manifest with no per-runtime memory special-case IS the deliverable.
 */
describe('buildSandboxPodSpec asset-manifest mounts (golden master)', () => {
  /** The skills/memory/ssh asset mounts, in whatever order pod-spec emits them. */
  const assetMounts = (podSpec: Awaited<ReturnType<typeof buildSpec>>) =>
    (podSpec.spec?.containers?.[0]?.volumeMounts ?? []).filter(
      (m: any) =>
        typeof m.subPath === 'string' &&
        (m.subPath.startsWith('skills/') || m.subPath.startsWith('memory/') || m.subPath.startsWith('ssh/'))
    )

  test('solo agent: skills only', async () => {
    const podSpec = await buildSpec({
      sandboxId: 'agent_solo1',
      podName: 'tau-sb-agent-solo1',
      config: { sandboxType: 'agent', privateStorageKey: 'agent_solo1' }, // no squadId → solo
    })
    const expected = [
      {
        name: 'core-data',
        mountPath: getSandboxSkillsDir('agent_solo1'),
        subPath: 'skills/sandboxes/agent-solo1',
        readOnly: true,
      },
    ]
    const actual = assetMounts(podSpec)
    expect(actual).toEqual(expect.arrayContaining(expected))
    expect(actual).toHaveLength(expected.length)
  })

  test('squad member: skills + ssh (NO memory — deliberate change)', async () => {
    const podSpec = await buildSpec({
      sandboxId: 'agent_xyz789',
      podName: 'tau-sb-agent-xyz789',
      config: { sandboxType: 'agent', squadId: '11111111-1111-4111-8111-111111111111', privateStorageKey: 'agent_w_2' },
    })
    const expected = [
      {
        name: 'core-data',
        mountPath: getSandboxSkillsDir('agent_xyz789'),
        subPath: 'skills/sandboxes/agent-xyz789',
        readOnly: true,
      },
      {
        name: 'core-data',
        mountPath: '/var/lib/ficus/ssh-source',
        subPath: 'ssh/11111111-1111-4111-8111-111111111111',
      },
    ]
    const actual = assetMounts(podSpec)
    expect(actual).toEqual(expect.arrayContaining(expected))
    expect(actual).toHaveLength(expected.length)
  })

  test('squad box: skills + memory + ssh', async () => {
    const podSpec = await buildSpec({
      sandboxId: 'squad_11111111-1111-4111-8111-111111111111',
      podName: 'tau-sb-squad-11111111-1111-4111-8111-111111111111',
      config: { sandboxType: 'squad' },
    })
    const expected = [
      {
        name: 'core-data',
        mountPath: getSandboxSkillsDir('squad_11111111-1111-4111-8111-111111111111'),
        subPath: 'skills/sandboxes/squad-11111111-1111-4111-8111-111111111111',
        readOnly: true,
      },
      {
        name: 'core-data',
        mountPath: '/memory/11111111-1111-4111-8111-111111111111',
        subPath: 'memory/11111111-1111-4111-8111-111111111111',
        readOnly: true,
      },
      {
        name: 'core-data',
        mountPath: '/var/lib/ficus/ssh-source',
        subPath: 'ssh/11111111-1111-4111-8111-111111111111',
      },
    ]
    const actual = assetMounts(podSpec)
    expect(actual).toEqual(expect.arrayContaining(expected))
    expect(actual).toHaveLength(expected.length)
  })
})
