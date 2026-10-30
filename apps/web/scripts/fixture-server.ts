/** Shared Vite dev server for the DB-free browser checks in this folder (`check-*.ts`).
 *
 * Every check serves its fixture page with the same config, so all checks share one Vite
 * dependency cache: the cache hash covers the config, including plugin names, and a per-check
 * config made each check throw away the cache left by the previous one.
 *
 * `startFixtureServer` also waits for Vite's first dependency build before it returns, so no
 * browser opens until the page can load quickly. On a cold cache that build takes longer than the
 * checks' page timeouts; a check that timed out then closed the server mid-build, the cache was
 * never written, and every rerun failed the same way.
 *
 * Optional `FIXTURE_CACHE_DIR` points Vite at another dependency cache, for example an empty
 * directory to reproduce a cold start. The default is Vite's own (`apps/web/node_modules/.vite`).
 */
import type { ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import { createServer, type LogLevel, type ViteDevServer } from 'vite'

const root = resolve(import.meta.dir, '..')

export interface FixtureServerOptions {
  /** Fixture module the page loads, from the `apps/web` root, for example `/scripts/fixtures/spend.tsx`. */
  entry: string
  /** Page path that serves the fixture, for example `/spend-fixture`. When omitted, every HTML
   * request gets the fixture page, so client-side routes load it too. */
  path?: string
  logLevel?: LogLevel
  /** Vite dependency cache directory. Defaults to `FIXTURE_CACHE_DIR`, then to Vite's default. */
  cacheDir?: string
}

/** Starts a listening Vite dev server for one fixture page, with its dependencies already built. */
export async function startFixtureServer({
  entry,
  path,
  logLevel,
  cacheDir = process.env.FIXTURE_CACHE_DIR,
}: FixtureServerOptions): Promise<ViteDevServer> {
  const html = `<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`
  const serveFixture = (res: ServerResponse) => {
    res.setHeader('Content-Type', 'text/html')
    res.end(html)
  }
  const server = await createServer({
    configFile: false,
    root,
    cacheDir: cacheDir ? resolve(cacheDir) : undefined,
    logLevel,
    resolve: { dedupe: ['react', 'react-dom'] },
    server: { host: '127.0.0.1', port: 0 },
    esbuild: { jsx: 'automatic' },
    plugins: [
      {
        // Keep this name and the config above the same for every check; both are part of the
        // dependency cache hash. The entry and path are not.
        name: 'ficus-browser-fixture',
        configureServer(server) {
          if (path) server.middlewares.use(path, (_req, res) => serveFixture(res))
          else
            server.middlewares.use((req, res, next) =>
              req.headers.accept?.includes('text/html') ? serveFixture(res) : next()
            )
        },
      },
    ],
  })
  try {
    await server.listen()
    await waitForDependencyBuild(server, entry)
    return server
  } catch (error) {
    await server.close()
    throw error
  }
}

/** Loads the fixture's module graph inside Vite and waits until its optimized dependencies are
 * built and written to the cache. With a warm cache this only pre-transforms the page's modules. */
async function waitForDependencyBuild(server: ViteDevServer, entry: string) {
  // Transforming the entry makes Vite pre-transform its static imports. Once those requests are
  // idle, the optimizer has seen every dependency the page imports and builds them in one batch.
  await server.warmupRequest(entry)
  await server.waitForRequestsIdle()
  // An optimized dependency module loads only after that batch is committed to the cache.
  const { moduleGraph, depsOptimizer } = server.environments.client
  const dependencies = [...moduleGraph.urlToModuleMap.keys()].filter((url) => depsOptimizer?.isOptimizedDepUrl(url))
  // A rerun for a late discovery can make some of these URLs outdated; the browser then gets the
  // new ones. Either way each request settles only after the build, which is all this waits for.
  await Promise.allSettled(dependencies.map((url) => server.transformRequest(url)))
}
