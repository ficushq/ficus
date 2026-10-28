import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
test('production body policy covers public and private routes before handlers; listener permits files', () => {
  const source = readFileSync(join(import.meta.dir, '../index.ts'), 'utf8')
  expect(source).toContain('maxRequestBodySize: Infinity')
  for (const mount of ['auth', 'webhooks']) {
    const limiter = source.indexOf(`app.use('/api/${mount}/*', requestBodyLimits)`)
    expect(limiter).toBeGreaterThan(source.indexOf("app.use('/api/*', csrfProtection)"))
    expect(limiter).toBeLessThan(source.indexOf(`app.route('/api/${mount}'`))
  }
  const privateLimiter = source.indexOf("app.use('/api/*', requestBodyLimits)")
  expect(privateLimiter).toBeGreaterThan(source.indexOf("app.use('/api/*', authzSentinel)"))
  expect(privateLimiter).toBeLessThan(source.indexOf("app.route('/api/sessions'"))
})
