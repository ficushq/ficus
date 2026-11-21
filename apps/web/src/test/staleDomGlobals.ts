/**
 * Remembers the globals each finished DOM harness installed (its window, document, bound timers,
 * fetch and so on). A test that saves one of them after acquiring the harness, for example through
 * spyOn(globalThis, 'setTimeout'), and puts it back after dom.cleanup() reinstalls that finished
 * window's function for the rest of the process; the window is closed, so its timers never fire.
 * The test preload checks for this around every test, puts back what cleanup restored, and fails
 * the test.
 */

// Keyed weakly by the installed value, so a finished window is not kept alive by this record.
const retired = new WeakMap<object, PropertyDescriptor | undefined>()
const names = new Set<string>()

/** Called by harness cleanup with each global it installed and the descriptor it put back. */
export function retireDomGlobal(name: string, value: unknown, restored: PropertyDescriptor | undefined) {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return
  // Some window members are the process's own (Happy DOM's SyntaxError is the realm's); those are not stale.
  if (restored && 'value' in restored && restored.value === value) return
  names.add(name)
  retired.set(value, restored)
}

/**
 * Finds globals that still hold a value a finished harness installed, puts back the descriptor that
 * harness's cleanup restored, and returns their names.
 */
export function takeStaleDomGlobals() {
  const stale: string[] = []
  for (const name of names) {
    // What a harness restored can itself be an earlier harness's leaked value; follow it back.
    for (let hop = 0; hop < 8; hop++) {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, name)
      const value: unknown = descriptor && 'value' in descriptor ? descriptor.value : undefined
      if ((typeof value !== 'object' && typeof value !== 'function') || value === null || !retired.has(value)) break
      if (hop === 0) stale.push(name)
      const restored = retired.get(value)
      if (restored) Object.defineProperty(globalThis, name, restored)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
  return stale
}

export function describeStaleDomGlobals(stale: string[]) {
  return (
    `A finished DOM harness's ${stale.join(', ')} ${stale.length === 1 ? 'was' : 'were'} still installed as ${stale.length === 1 ? 'a global' : 'globals'}. ` +
    'A value saved after acquiring the harness was put back after dom.cleanup(). ' +
    'Restore spies and saved globals before dom.cleanup(); the harness restores its own globals.'
  )
}
