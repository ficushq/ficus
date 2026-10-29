/** One readiness promise, including failures: concurrent callers cannot reset
 * rows, repeat a schema push, or retry a partially initialized database. */
export function lazyTestDatabase(setup: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | undefined
  return () => (pending ??= Promise.resolve().then(setup))
}
