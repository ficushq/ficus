/**
 * Test preload: make hoisted root React 19.1 use the same module references as
 * web React 19.2.4, so hoisted providers and the web renderer share a dispatcher.
 *
 * The web workspace's semver range currently installs React/ReactDOM 19.2.4
 * locally, while a root dependency may resolve another version. Hoisted
 * packages such as react-router and React Query therefore load root React, but
 * web tests load their renderer from apps/web/node_modules. Mixing those module
 * instances produces invalid-hook-call and dispatcher errors.
 *
 * Redirect root React/ReactDOM entry points to the web-local modules when that
 * split install layout exists. In a single-hoisted-React or partial worktree
 * install there is nothing to reconcile, so this preload deliberately no-ops.
 */
import { afterEach, mock } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const WEB = join(import.meta.dir, '..', 'node_modules')
const ROOT = join(import.meta.dir, '..', '..', '..', 'node_modules')
const hasWebLocalReact = existsSync(join(WEB, 'react', 'index.js')) && existsSync(join(WEB, 'react-dom', 'server.js'))

// React's scheduler reads window.event when resolving the priority of a queued
// state update. Interactive suites install full isolated DOM owners, but an
// already-cancelled observer can still reach its final no-op dispatch after an
// owner restores the preload state. Keep that exact baseline SSR-friendly
// (there is intentionally no document) while ensuring late React bookkeeping
// cannot crash merely because the window binding disappeared.
const schedulerWindow = {
  event: undefined,
  location: { hash: '', pathname: '/', search: '' },
} as unknown as typeof globalThis.window
if (typeof globalThis.window === 'undefined') {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    enumerable: false,
    writable: true,
    value: schedulerWindow,
  })
}
afterEach(() => {
  if (typeof globalThis.window === 'undefined') globalThis.window = schedulerWindow
})

if (hasWebLocalReact) {
  // Pre-import web React modules before mocking their root counterparts.
  const [webReact, webReactJsx, webReactJsxDev, webReactCjs, webReactDom, webReactDomServer] = await Promise.all([
    import(`${WEB}/react/index.js`),
    import(`${WEB}/react/jsx-runtime.js`),
    import(`${WEB}/react/jsx-dev-runtime.js`),
    import(`${WEB}/react/cjs/react.development.js`),
    import(`${WEB}/react-dom/index.js`),
    import(`${WEB}/react-dom/server.js`),
  ])

  mock.module(`${ROOT}/react/index.js`, () => webReact)
  mock.module(`${ROOT}/react/jsx-runtime.js`, () => webReactJsx)
  mock.module(`${ROOT}/react/jsx-dev-runtime.js`, () => webReactJsxDev)
  mock.module(`${ROOT}/react/cjs/react.development.js`, () => webReactCjs)
  mock.module(`${ROOT}/react-dom/index.js`, () => webReactDom)
  mock.module(`${ROOT}/react-dom/server.js`, () => webReactDomServer)
}
