import type { Context } from 'hono'

/**
 * A named route parameter that the matched path must declare.
 *
 * Hono types `c.req.param(name)` as `string | undefined` wherever the path is not
 * known statically, such as a permission loader built outside its route or a
 * handler helper that takes a plain `Context`. Those callers are only mounted on
 * paths that declare `:name`, so a missing value means the code was wired to the
 * wrong route. That is a server bug, so this throws instead of passing
 * `undefined` along: permission loaders turn the throw into a 403 (they fail
 * closed) and handlers turn it into a 500.
 */
export function routeParam(c: Context, name: string): string {
  const value = c.req.param(name)
  if (value === undefined) {
    throw new Error(
      `Route parameter "${name}" is missing: ${c.req.method} ${c.req.path} is not mounted on a :${name} path`
    )
  }
  return value
}
