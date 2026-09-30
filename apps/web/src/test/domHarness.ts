import { act } from 'react'
import type { createRoot as CreateRoot, Root } from 'react-dom/client'
import { Window } from 'happy-dom'
import { acquireDomOwnershipLease } from './domOwnership'
export { withDomOwnership } from './domOwnership'

let createRootImpl: typeof CreateRoot | undefined

export const DOM_GLOBAL_NAMES = [
  'IS_REACT_ACT_ENVIRONMENT',
  'window',
  'document',
  'navigator',
  'localStorage',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLSelectElement',
  'HTMLTextAreaElement',
  'Element',
  'Node',
  'Event',
  'EventTarget',
  'CustomEvent',
  'DOMException',
  'InputEvent',
  'TouchEvent',
  'MouseEvent',
  'KeyboardEvent',
  'File',
  'FileList',
  'Blob',
  'FormData',
  'MutationObserver',
  'ResizeObserver',
  'fetch',
  'SyntaxError',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'requestAnimationFrame',
  'cancelAnimationFrame',
] as const

type DomGlobalName = (typeof DOM_GLOBAL_NAMES)[number]
type DescriptorSnapshot = Map<DomGlobalName, PropertyDescriptor | undefined>

function restoreDescriptors(descriptors: DescriptorSnapshot) {
  for (const name of [...DOM_GLOBAL_NAMES].reverse()) {
    const descriptor = descriptors.get(name)
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else Reflect.deleteProperty(globalThis, name)
  }
}

/** Installs an isolated Happy DOM window and restores every global descriptor exactly on cleanup. */
type DomHarnessOptions = {
  url: string
  windowOptions?: Omit<NonNullable<ConstructorParameters<typeof Window>[0]>, 'url'>
  configureWindow?: (window: Window) => void
  failAfterInstalling?: DomGlobalName
  beforeUnmount?: () => void | Promise<void>
  afterUnmount?: () => void | Promise<void>
}

export function installDomHarness({
  url,
  windowOptions,
  configureWindow,
  failAfterInstalling,
  beforeUnmount,
  afterUnmount,
}: DomHarnessOptions) {
  const descriptors = new Map(
    DOM_GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const)
  )
  const previousWindow = globalThis.window
  const previousLocation = previousWindow?.location
    ? {
        hash: previousWindow.location.hash,
        pathname: previousWindow.location.pathname,
        search: previousWindow.location.search,
      }
    : undefined
  const window = new Window({ ...windowOptions, url })
  if (windowOptions?.innerWidth !== undefined) window.innerWidth = windowOptions.innerWidth
  if (windowOptions?.innerHeight !== undefined) window.innerHeight = windowOptions.innerHeight

  type ListenerEntry = {
    target: object
    type: string
    listener: unknown
    capture: boolean
  }
  const listeners: ListenerEntry[] = []
  let eventTargetPrototype = window.EventTarget.prototype
  while (!Object.prototype.hasOwnProperty.call(eventTargetPrototype, 'addEventListener')) {
    eventTargetPrototype = Object.getPrototypeOf(eventTargetPrototype) as typeof eventTargetPrototype
  }
  const addEventListenerDescriptor = Object.getOwnPropertyDescriptor(eventTargetPrototype, 'addEventListener')!
  const removeEventListenerDescriptor = Object.getOwnPropertyDescriptor(eventTargetPrototype, 'removeEventListener')!
  const nativeAddEventListener = eventTargetPrototype.addEventListener
  const nativeRemoveEventListener = eventTargetPrototype.removeEventListener
  eventTargetPrototype.addEventListener = function (
    this: object,
    type: string,
    listener: unknown,
    options?: boolean | { capture?: boolean }
  ) {
    if (listener) {
      listeners.push({
        target: this,
        type,
        listener,
        capture: typeof options === 'boolean' ? options : (options?.capture ?? false),
      })
    }
    return Reflect.apply(nativeAddEventListener, this, [type, listener, options])
  } as typeof eventTargetPrototype.addEventListener
  eventTargetPrototype.removeEventListener = function (
    this: object,
    type: string,
    listener: unknown,
    options?: boolean | { capture?: boolean }
  ) {
    const capture = typeof options === 'boolean' ? options : (options?.capture ?? false)
    let index = listeners.length - 1
    while (index >= 0) {
      const entry = listeners[index]!
      if (entry.target === this && entry.type === type && entry.listener === listener && entry.capture === capture)
        break
      index--
    }
    if (index !== -1) listeners.splice(index, 1)
    return Reflect.apply(nativeRemoveEventListener, this, [type, listener, options])
  } as typeof eventTargetPrototype.removeEventListener
  try {
    configureWindow?.(window)
  } catch (error) {
    Object.defineProperty(eventTargetPrototype, 'addEventListener', addEventListenerDescriptor)
    Object.defineProperty(eventTargetPrototype, 'removeEventListener', removeEventListenerDescriptor)
    window.close()
    throw error
  }
  const pendingTimeouts = new Set<ReturnType<typeof window.setTimeout>>()
  const nativeSetTimeout = window.setTimeout.bind(window)
  const nativeClearTimeout = window.clearTimeout.bind(window)
  const pendingIntervals = new Set<ReturnType<typeof window.setInterval>>()
  const nativeSetInterval = window.setInterval.bind(window)
  const nativeClearInterval = window.clearInterval.bind(window)
  window.setTimeout = ((handler: (...args: unknown[]) => unknown, timeout?: number, ...args: unknown[]) => {
    const handle = nativeSetTimeout(handler, timeout, ...args)
    pendingTimeouts.add(handle)
    return handle
  }) as typeof window.setTimeout
  window.clearTimeout = ((handle: ReturnType<typeof window.setTimeout>) => {
    pendingTimeouts.delete(handle)
    return nativeClearTimeout(handle)
  }) as typeof window.clearTimeout
  window.setInterval = ((handler: (...args: unknown[]) => unknown, timeout?: number, ...args: unknown[]) => {
    const handle = nativeSetInterval(handler, timeout, ...args)
    pendingIntervals.add(handle)
    return handle
  }) as typeof window.setInterval
  window.clearInterval = ((handle: ReturnType<typeof window.setInterval>) => {
    pendingIntervals.delete(handle)
    return nativeClearInterval(handle)
  }) as typeof window.clearInterval
  const values: Record<DomGlobalName, unknown> = {
    IS_REACT_ACT_ENVIRONMENT: true,
    window,
    document: window.document,
    navigator: window.navigator,
    localStorage: window.localStorage,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLSelectElement: window.HTMLSelectElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    Element: window.Element,
    Node: window.Node,
    Event: window.Event,
    EventTarget: window.EventTarget,
    CustomEvent: window.CustomEvent,
    DOMException: window.DOMException,
    InputEvent: window.InputEvent,
    TouchEvent: window.TouchEvent,
    MouseEvent: window.MouseEvent,
    KeyboardEvent: window.KeyboardEvent,
    File: window.File,
    FileList: window.FileList,
    Blob: window.Blob,
    FormData: window.FormData,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    fetch: window.fetch.bind(window),
    SyntaxError: window.SyntaxError,
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
    setInterval: window.setInterval.bind(window),
    clearInterval: window.clearInterval.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  }
  try {
    for (const name of DOM_GLOBAL_NAMES) {
      const descriptor = descriptors.get(name)
      if (name === 'window' && descriptor?.set) {
        globalThis.window = values[name] as typeof globalThis.window
      } else {
        Object.defineProperty(globalThis, name, {
          configurable: true,
          enumerable: descriptor?.enumerable ?? false,
          writable: true,
          value: values[name],
        })
      }
      if (name === failAfterInstalling) throw new Error(`injected DOM installation failure after ${name}`)
    }
  } catch (error) {
    for (const handle of pendingTimeouts) nativeClearTimeout(handle)
    for (const handle of pendingIntervals) nativeClearInterval(handle)
    Object.defineProperty(eventTargetPrototype, 'addEventListener', addEventListenerDescriptor)
    Object.defineProperty(eventTargetPrototype, 'removeEventListener', removeEventListenerDescriptor)
    window.close()
    globalThis.window = previousWindow
    restoreDescriptors(descriptors)
    throw error
  }

  const roots: Array<{ root: Root; container: HTMLElement }> = []
  let cleaned = false
  return {
    window,
    act,
    createRoot() {
      const windowContainer = window.document.createElement('div')
      window.document.body.appendChild(windowContainer)
      const container = windowContainer as unknown as HTMLElement
      if (!createRootImpl) throw new Error('DOM harness root creation requires acquireDomHarness')
      const root = createRootImpl(container)
      roots.push({ root, container })
      return { root, container }
    },
    async cleanup() {
      if (cleaned) return
      cleaned = true
      try {
        await act(async () => {
          let cleanupError: unknown
          try {
            await beforeUnmount?.()
          } catch (error) {
            cleanupError = error
          }
          await Bun.sleep(0)
          for (const { root } of [...roots].reverse()) {
            try {
              root.unmount()
            } catch (error) {
              cleanupError ??= error
            }
          }
          await Promise.resolve()
          try {
            await afterUnmount?.()
          } catch (error) {
            cleanupError ??= error
          }
          for (const handle of pendingTimeouts) nativeClearTimeout(handle)
          pendingTimeouts.clear()
          for (const handle of pendingIntervals) nativeClearInterval(handle)
          pendingIntervals.clear()
          // Give React's scheduler a macrotask on both sides of unmount while
          // this owner is still installed. Query work was cancelled explicitly
          // above; unlike Happy DOM's global task manager this cannot wait on
          // unrelated promises created by another test file.
          await Bun.sleep(0)
          await Bun.sleep(0)
          if (cleanupError) throw cleanupError
        })
      } finally {
        try {
          for (const { container } of roots) container.remove()
          for (const entry of [...listeners].reverse()) {
            Reflect.apply(nativeRemoveEventListener, entry.target, [entry.type, entry.listener, entry.capture])
          }
          listeners.length = 0
          Object.defineProperty(eventTargetPrototype, 'addEventListener', addEventListenerDescriptor)
          Object.defineProperty(eventTargetPrototype, 'removeEventListener', removeEventListenerDescriptor)
          for (const handle of pendingTimeouts) nativeClearTimeout(handle)
          pendingTimeouts.clear()
          for (const handle of pendingIntervals) nativeClearInterval(handle)
          pendingIntervals.clear()
          window.close()
        } finally {
          if (previousLocation && previousWindow?.location) {
            previousWindow.location.hash = previousLocation.hash
            previousWindow.location.pathname = previousLocation.pathname
            previousWindow.location.search = previousLocation.search
          }
          globalThis.window = previousWindow
          restoreDescriptors(descriptors)
        }
      }
    },
  }
}

/** Serializes process-global DOM ownership across test files. Cleanup releases the next waiter. */
export async function acquireDomHarness(options: DomHarnessOptions) {
  const release = await acquireDomOwnershipLease()
  let harness: ReturnType<typeof installDomHarness> | undefined
  try {
    harness = installDomHarness(options)
    createRootImpl ??= (await import('react-dom/client')).createRoot
  } catch (error) {
    try {
      if (harness) await harness.cleanup()
    } catch {
      // Preserve the installation/import error; cleanup still restores globals in its finally path.
    } finally {
      release()
    }
    throw error
  }
  const cleanup = harness.cleanup
  let cleanupPromise: Promise<void> | undefined
  return {
    ...harness,
    cleanup() {
      cleanupPromise ??= (async () => {
        try {
          await cleanup()
        } finally {
          release()
        }
      })()
      return cleanupPromise
    },
  }
}
