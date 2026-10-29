// The test preload registers readiness before application modules load. Keeping
// this seam dependency-free means production never imports test or Docker code.
let initialize: (() => Promise<void>) | undefined

export function registerTestDatabase(initializer: () => Promise<void>): void {
  if (initialize) throw new Error('Test database initializer already registered')
  initialize = initializer
}

/** Raw-client tests must await this before reading DATABASE_URL/pooler flags. */
export function ensureTestDatabase(): Promise<void> {
  return initialize?.() ?? Promise.resolve()
}
