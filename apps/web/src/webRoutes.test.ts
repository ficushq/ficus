import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { WEB_APP_ROUTE_SEGMENTS } from '@ficus/shared/web-routes'

/**
 * Core refuses to strip a public-address base path that shadows a web route,
 * using WEB_APP_ROUTE_SEGMENTS. Adding a top-level route without updating that
 * constant would silently let such a base shadow the new page, so the router
 * source is the reference here.
 */
function routerFirstSegments(): Set<string> {
  const app = readFileSync(join(import.meta.dir, 'App.tsx'), 'utf8')
  const nav = readFileSync(join(import.meta.dir, 'components', 'navModel.tsx'), 'utf8')
  const segments = new Set<string>()
  for (const match of app.matchAll(/<Route\s+path="\/([^/"*:?]+)/g)) segments.add(match[1])
  for (const match of app.matchAll(/location\.pathname === '\/([^/']+)/g)) segments.add(match[1])
  const farmSignIn = nav.match(/FARM_SIGN_IN_PATH = '\/([^/']+)'/)
  if (farmSignIn) segments.add(farmSignIn[1])
  return segments
}

describe('WEB_APP_ROUTE_SEGMENTS', () => {
  test('matches the first segments of the web router', () => {
    expect([...routerFirstSegments()].sort()).toEqual([...WEB_APP_ROUTE_SEGMENTS].sort())
  })
})
