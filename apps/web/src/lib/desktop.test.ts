import { afterEach, describe, expect, test } from 'bun:test'
import { desktopBridge, desktopInstance, type DesktopBridge } from './desktop'

afterEach(() => {
  delete window.tauDesktopApp
  delete window.ficusDesktopApp
})

function bridge(): DesktopBridge {
  return { version: 1, notificationsEnabled: async () => false, deliverNotifications: async () => {} }
}

describe('desktopBridge (dual-read)', () => {
  test('detects the bridge from window.ficusDesktopApp alone', () => {
    const ficus = bridge()
    window.ficusDesktopApp = ficus
    expect(desktopBridge()).toBe(ficus)
  })

  test('detects the bridge from window.tauDesktopApp alone (D1 and older Desktop builds)', () => {
    const tau = bridge()
    window.tauDesktopApp = tau
    expect(desktopBridge()).toBe(tau)
  })

  test('window.ficusDesktopApp wins when both are set', () => {
    const ficus = bridge()
    const tau = bridge()
    window.ficusDesktopApp = ficus
    window.tauDesktopApp = tau
    expect(desktopBridge()).toBe(ficus)
  })
})

describe('desktopInstance', () => {
  test('returns undefined without a bridge', () => {
    expect(desktopInstance()).toBeUndefined()
  })

  test('returns undefined when instance.kind is not one of the three kinds', () => {
    window.tauDesktopApp = {
      version: 1,
      notificationsEnabled: async () => false,
      deliverNotifications: async () => {},
      // @ts-expect-error exercising an invalid kind from an untrusted/older bridge
      instance: { kind: 'bogus', name: 'noah' },
    }

    expect(desktopInstance()).toBeUndefined()
  })

  test('returns undefined when name is not a string', () => {
    window.tauDesktopApp = {
      version: 1,
      notificationsEnabled: async () => false,
      deliverNotifications: async () => {},
      // @ts-expect-error exercising a malformed name from an untrusted/older bridge
      instance: { kind: 'local', name: 42 },
    }

    expect(desktopInstance()).toBeUndefined()
  })

  test('returns the instance when kind and name are valid', () => {
    const instance = { kind: 'remote' as const, name: 'noah' }
    window.tauDesktopApp = {
      version: 1,
      notificationsEnabled: async () => false,
      deliverNotifications: async () => {},
      instance,
    }

    expect(desktopInstance()).toBe(instance)
  })

  test('returns undefined when name is empty or all whitespace', () => {
    window.tauDesktopApp = {
      version: 1,
      notificationsEnabled: async () => false,
      deliverNotifications: async () => {},
      instance: { kind: 'local', name: '   ' },
    }

    expect(desktopInstance()).toBeUndefined()
  })

  test('drops a non-function disconnect from an untrusted/older bridge', () => {
    window.tauDesktopApp = {
      version: 1,
      notificationsEnabled: async () => false,
      deliverNotifications: async () => {},
      instance: {
        kind: 'remote',
        name: 'noah',
        // @ts-expect-error exercising a malformed disconnect from an untrusted/older bridge
        disconnect: 'not a function',
      },
    }

    const instance = desktopInstance()
    expect(instance).toEqual({ kind: 'remote', name: 'noah' })
    expect(instance?.disconnect).toBeUndefined()
  })

  test('keeps a function disconnect', () => {
    const disconnect = async () => {}
    const instance = { kind: 'remote' as const, name: 'noah', disconnect }
    window.tauDesktopApp = {
      version: 1,
      notificationsEnabled: async () => false,
      deliverNotifications: async () => {},
      instance,
    }

    expect(desktopInstance()).toBe(instance)
  })
})
