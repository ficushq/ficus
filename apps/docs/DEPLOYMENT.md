# Building and hosting documentation

From the repository root, with Bun 1.3.8 and Node.js 22.12 or newer:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check:docs
```

The standalone output is `apps/docs/dist/`. Deploy the complete directory,
including `_astro/`, Pagefind, images and sitemap files, to a static host. No
application server, database or runtime credentials are required. Set the site
origin in `astro.config.mjs` for your deployment.

Serve directory `index.html` files and return `404.html` with status 404 for
unknown routes. Verify direct links to nested pages, search, images, and both
color themes. Deploy atomically and keep HTML and search indexes from the same
build. Fingerprinted `_astro` assets can be cached immutably.

The current standalone profile discourages indexing through its robots and head
settings. Adjust those deliberately for your deployment; they are not access
controls. Only curated content under `src/content/docs` and its assets feed the
website. Publish the build output, not the source checkout.

## Embedded instance docs

Every Core build also builds this content with base `/docs/` into
`apps/core/docs-dist/`. Both cloud and self-hosted instances serve it on the Core
port, even with `FICUS_SERVE_WEB` disabled. Open `/docs/` on the instance origin.
Core release artifacts and Docker images include the complete output; upgrading
the release upgrades its docs at the same time. No separate docs service or
runtime Node installation is required. Builders need Node.js 22.12 or newer.

`bun run check:docs` validates both profiles. To build only embedded docs, run
`bun run --filter @ficus/docs build:embedded`. This profile keeps noindex and omits
a fixed canonical site origin. Documentation is static product content, publicly
readable like the app shell; API authentication and any outer network/access
controls remain in place. Unknown docs pages return a real 404; a missing docs
build returns 503 with an explanation. The app service worker does not cache or
rewrite these routes.
