import { SANDBOX_IDENTITY_LEGACY } from './retired-identity.fixture'
import { describe, expect, test } from 'bun:test'
import {
  readSandboxLabel,
  SANDBOX_IDENTITY_NEW,
  SANDBOX_IDENTITY_READ,
  SANDBOX_IDENTITY_WRITE,
  sandboxContainerNames,
  sandboxPodLabelSelector,
  type SandboxIdentitySet,
} from './identity-names'

const KEYS: (keyof SandboxIdentitySet)[] = [
  'containerPrefix',
  'managedLabel',
  'sandboxIdLabel',
  'specHashLabel',
  'lifecycleGenerationLabel',
  'imageIdLabel',
  'imageLabelNamespace',
  'k8sSpecHashAnnotation',
  'k8sAppLabelValue',
  'k8sPodNamePrefix',
]

describe('sandbox identity names', () => {
  test('the new set carries the Ficus names', () => {
    expect(SANDBOX_IDENTITY_NEW).toEqual({
      containerPrefix: 'ficus-sandbox-',
      managedLabel: 'ficus.managed',
      sandboxIdLabel: 'ficus.sandbox-id',
      specHashLabel: 'ficus.spec-hash',
      lifecycleGenerationLabel: 'ficus.lifecycle-generation',
      imageIdLabel: 'ficus.image-id',
      imageLabelNamespace: 'sh.ficus.sandbox',
      k8sSpecHashAnnotation: 'ficus.sh/spec-hash',
      k8sAppLabelValue: 'ficus-sandbox',
      k8sPodNamePrefix: 'ficus-sb-',
    })
  })

  test('the two sets share no name, so a label always says which set wrote it', () => {
    for (const key of KEYS) expect(SANDBOX_IDENTITY_LEGACY[key]).not.toBe(SANDBOX_IDENTITY_NEW[key])
  })

  test('this release writes and reads only the canonical set', () => {
    expect(SANDBOX_IDENTITY_WRITE).toBe(SANDBOX_IDENTITY_NEW)
    expect(SANDBOX_IDENTITY_READ).toEqual([SANDBOX_IDENTITY_NEW])
  })

  test('readSandboxLabel ignores values under the retired set', () => {
    expect(readSandboxLabel({ 'ficus.spec-hash': 'a' }, (s) => s.specHashLabel)).toBe('a')
    expect(readSandboxLabel({ [SANDBOX_IDENTITY_LEGACY.specHashLabel]: 'a' }, (s) => s.specHashLabel)).toBeUndefined()
    expect(readSandboxLabel({ 'ficus.sh/spec-hash': 'h' }, (s) => s.k8sSpecHashAnnotation)).toBe('h')
    expect(readSandboxLabel({ other: 'a' }, (s) => s.specHashLabel)).toBeUndefined()
    expect(readSandboxLabel({}, (s) => s.managedLabel)).toBeUndefined()
  })

  test('readSandboxLabel keeps an empty value (present is not absent)', () => {
    expect(readSandboxLabel({ 'ficus.lifecycle-generation': '' }, (s) => s.lifecycleGenerationLabel)).toBe('')
  })

  test('container names: the write name first, then every other read name', () => {
    const names = sandboxContainerNames('agent_x')
    expect(names[0]).toBe(`${SANDBOX_IDENTITY_WRITE.containerPrefix}agent_x`)
    expect(names).toHaveLength(1)
    expect(names).toContain('ficus-sandbox-agent_x')
    expect(names).not.toContain(`${SANDBOX_IDENTITY_LEGACY.containerPrefix}agent_x`)
  })

  test('the pod selector matches the app value of every read set', () => {
    expect(sandboxPodLabelSelector()).toBe('app in (ficus-sandbox)')
  })
})
