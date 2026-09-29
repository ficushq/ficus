import { describe, expect, it } from 'bun:test'
import { SANDBOX_IDENTITY_LEGACY, SANDBOX_IDENTITY_NEW, type SandboxIdentitySet } from '../identity-names'
import { classifyDockerContainerOwnership, classifyDockerInspectStatus } from './lifecycle-contract'

describe('classifyDockerInspectStatus', () => {
  it('treats any inspect success as present', () => {
    expect(classifyDockerInspectStatus(0, '')).toBe('running')
  })

  it('recognizes only an authoritative missing-container response as absent', () => {
    expect(classifyDockerInspectStatus(1, 'Error: No such object: tau-sandbox-squad_x')).toBe('not_found')
    expect(classifyDockerInspectStatus(1, 'Cannot connect to the Docker daemon')).toBe('unknown')
  })
})

describe('classifyDockerContainerOwnership', () => {
  const sandboxId = 'agent_x'
  const owned = (set: SandboxIdentitySet, extraLabels: Record<string, string> = {}) => ({
    Name: `/${set.containerPrefix}${sandboxId}`,
    Config: { Labels: { [set.managedLabel]: 'true', [set.sandboxIdLabel]: sandboxId, ...extraLabels } },
  })

  it('accepts exact current ownership under either identity set', () => {
    expect(classifyDockerContainerOwnership(owned(SANDBOX_IDENTITY_NEW), sandboxId)).toBe('current')
    expect(classifyDockerContainerOwnership(owned(SANDBOX_IDENTITY_LEGACY), sandboxId)).toBe('current')
  })

  it('rejects a labeled neighbor under either identity set', () => {
    for (const set of [SANDBOX_IDENTITY_NEW, SANDBOX_IDENTITY_LEGACY]) {
      const neighbor = owned(set, { [set.sandboxIdLabel]: 'neighbor' })
      expect(classifyDockerContainerOwnership(neighbor, sandboxId)).toBe('unproven')
    }
  })

  it('never claims a container without the managed label or a known prefix', () => {
    const unlabeled = { Name: `/${SANDBOX_IDENTITY_NEW.containerPrefix}${sandboxId}`, Config: { Labels: {} } }
    expect(classifyDockerContainerOwnership(unlabeled, sandboxId)).toBe('unproven')
    const foreignName = { ...owned(SANDBOX_IDENTITY_NEW), Name: `/someone-else-${sandboxId}` }
    expect(classifyDockerContainerOwnership(foreignName, sandboxId)).toBe('unproven')
    // Name and labels must come from the same set: one create call writes both.
    const crossed = { ...owned(SANDBOX_IDENTITY_NEW), Name: `/${SANDBOX_IDENTITY_LEGACY.containerPrefix}${sandboxId}` }
    expect(classifyDockerContainerOwnership(crossed, sandboxId)).toBe('unproven')
  })

  it('accepts legacy provenance only with exact name, spec, and workspace mount', () => {
    for (const set of [SANDBOX_IDENTITY_NEW, SANDBOX_IDENTITY_LEGACY]) {
      const legacy = {
        Name: `/${set.containerPrefix}${sandboxId}`,
        Config: { Labels: { [set.specHashLabel]: 'abc' } },
        Mounts: [{ Source: '/owned/workspace' }, { Source: '/neighbor' }],
      }
      expect(classifyDockerContainerOwnership(legacy, sandboxId, '/owned/workspace')).toBe('legacy')
      expect(classifyDockerContainerOwnership(legacy, sandboxId, '/different')).toBe('unproven')
      const foreign = { ...legacy, Name: `/someone-else-${sandboxId}` }
      expect(classifyDockerContainerOwnership(foreign, sandboxId, '/owned/workspace')).toBe('unproven')
    }
  })
})
