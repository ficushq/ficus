# Single-origin and reverse proxy deployment

Ficus can run behind one public hostname in two ways:

| Mode                                         | Pick this when                                                                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Built-in single-origin (`FICUS_SERVE_WEB=1`) | You want the simplest self-hosted VM or Docker deploy: `/`, `/api/*`, `/ws`, and `/ws/terminal` all come from Core on `:3000`. |
| Split-port reverse proxy                     | You want Core on `:3000` and a separately served web build or Vite server on `:5173`.                                          |
| Kubernetes/CDN split                         | You run the hosted-style Kubernetes topology with separate `tau-api`/`tau-web` deployments and CDN/static hosting.             |

## Built-in single-origin serving

Build the web UI, then let Core serve it on the same port as the API and WebSockets:

```bash
bun run build:web
FICUS_SERVE_WEB=1 bun run start
```

Core serves:

- `/api/*` -> Core API on `http://127.0.0.1:3000`
- `/ws` and `/ws/*` -> Core WebSockets on `http://127.0.0.1:3000`
- `/` and client-side routes -> `apps/web/dist`

`FICUS_SERVE_WEB=0` disables this even when `apps/web/dist` exists. When `FICUS_SERVE_WEB` is unset, Core safely auto-enables only if `apps/web/dist/index.html` exists.

For Docker single-image deployments, build with the web assets included and enable serving at runtime:

```bash
docker build --build-arg FICUS_INCLUDE_WEB=1 -t ficus-core:single-origin .
docker run -e FICUS_SERVE_WEB=1 -p 3000:3000 ficus-core:single-origin
```

## Caddy

On macOS: `brew install caddy && brew services start caddy`, add one of the
blocks below to the global Caddyfile (`/opt/homebrew/etc/Caddyfile`), then
`brew services restart caddy`. Build the web UI first (`bun run build:web`) for
any config that serves `apps/web/dist` itself.

### Single-origin Core

```caddyfile
ficus.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

### Split web/API ports

```caddyfile
ficus.example.com {
  handle /api/* {
    reverse_proxy 127.0.0.1:3000
  }

  handle /ws* {
    reverse_proxy 127.0.0.1:3000
  }

  # The farm UI (built into dist/farm) is its own app: its own HTML fallback, never the web app's.
  redir /farm /farm/ 301
  handle /farm/* {
    root * /path/to/ficus/apps/web/dist
    try_files {path} /farm/index.html
    file_server
    @farmHtml path /farm/ /farm/index.html
    header @farmHtml Cache-Control "no-cache"
    @farmAssets path /farm/assets/*
    header @farmAssets Cache-Control "public, max-age=31536000, immutable"
  }

  handle {
    root * /path/to/ficus/apps/web/dist
    try_files {path} /index.html
    file_server

    # PWA cache headers — REQUIRED when serving the dist statically.
    # Without an explicit Cache-Control, browsers cache heuristically and
    # CDNs (e.g. Cloudflare) edge-cache .js for hours, so sw.js can lag
    # index.html after a deploy. Mismatched builds make the app prompt for
    # (or auto-apply) phantom "updates" and can cause reload loops.
    @swAndHtml path /sw.js /index.html / /manifest.webmanifest
    header @swAndHtml Cache-Control "no-cache"
    @hashedAssets path /assets/*
    header @hashedAssets Cache-Control "public, max-age=31536000, immutable"
  }
}
```

The `/api/*` and `/ws*` handles both point at Core on `3000`. The bare `/ws`
route is what the app event WebSocket connects to and `/ws/terminal` is used for
terminal sessions, so a `/ws/*`-only matcher is not enough — match both.

### Serving the web build from a system web-server root

`bun run build:web` can sync the built files into a directory your web server
already owns. Configure it in `.env`:

```bash
WEB_DIST_SYNC_DIR=/var/www/ficus
WEB_DIST_SYNC_OWNER=caddy:caddy  # optional
```

Then point Caddy's `root` at that directory (`root * /var/www/ficus`). Leave
`WEB_DIST_SYNC_DIR` unset for normal local development, Docker, or Kubernetes
builds.

## nginx

```nginx
server {
  listen 80;
  server_name ficus.example.com;

  location /api/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  location /ws {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 1h;
  }

  location / {
    root /path/to/ficus/apps/web/dist;
    try_files $uri $uri/ /index.html;
  }

  # The farm UI (built into dist/farm) is its own app: its own HTML fallback, never the web app's.
  location = /farm {
    return 301 /farm/;
  }
  location /farm/ {
    root /path/to/ficus/apps/web/dist;
    try_files $uri /farm/index.html;
    add_header Cache-Control "no-cache";
  }
  location /farm/assets/ {
    root /path/to/ficus/apps/web/dist;
    add_header Cache-Control "public, max-age=31536000, immutable";
  }

  # PWA cache headers — REQUIRED when serving the dist statically (see the
  # Caddy example above for why). sw.js/index.html/manifest must revalidate;
  # hashed assets are immutable.
  location = /sw.js {
    root /path/to/ficus/apps/web/dist;
    add_header Cache-Control "no-cache";
  }
  location = /manifest.webmanifest {
    root /path/to/ficus/apps/web/dist;
    add_header Cache-Control "no-cache";
  }
  location /assets/ {
    root /path/to/ficus/apps/web/dist;
    add_header Cache-Control "public, max-age=31536000, immutable";
  }
}
```

If `FICUS_SERVE_WEB=1` is enabled, replace the `location /` file root with `proxy_pass http://127.0.0.1:3000;` so `/` is served by Core too. Core sets the correct PWA cache headers itself, which makes single-origin the least error-prone option.

> **CDN warning:** if a CDN fronts the site (Cloudflare et al.), it must see the `Cache-Control` headers above from the origin. Cloudflare's default behavior caches `.js` by extension for hours while treating HTML as dynamic — a recipe for a stale `sw.js` against a fresh `index.html`, which the app surfaces as spurious update prompts or blocked auto-updates. After fixing the origin headers, purge the CDN cache for `sw.js` once.

## Traefik docker-compose labels

For the built-in single-origin mode, route the whole host to Core:

```yaml
services:
  ficus-core:
    image: ficus-core:single-origin
    environment:
      FICUS_SERVE_WEB: '1'
    labels:
      - traefik.enable=true
      - traefik.http.routers.ficus.rule=Host(`ficus.example.com`)
      - traefik.http.routers.ficus.entrypoints=websecure
      - traefik.http.routers.ficus.tls.certresolver=letsencrypt
      - traefik.http.services.ficus.loadbalancer.server.port=3000
```

For split-port deployments, create separate routers: `/api/*`, `/ws`, and `/ws/*` to Core on `3000`, and `/` to the web service or static file server.

## Tailscale Serve

If you use [Tailscale](https://tailscale.com/), it can expose ficus over your
tailnet with automatic HTTPS and no public DNS at all. With the built-in
single-origin mode (`FICUS_SERVE_WEB=1`), point it at Core:

```bash
tailscale serve --bg --set-path=/tau http://localhost:3000
```

Ficus is then reachable at `https://<your-machine>.<tailnet>/ficus`. Because that
URL carries a path, set the base path and the WebAuthn origin explicitly, or
passkeys break:

```bash
APP_URL=https://<your-machine>.<tailnet>/tau
APP_BASE_PATH=/tau
FICUS_WEB_ORIGIN=https://<your-machine>.<tailnet>   # bare origin, no path
```

Serving at the tailnet root (`tailscale serve --bg http://localhost:3000`)
avoids the base-path handling entirely. For a split web/API deployment, point
Tailscale at the Vite dev server (`http://localhost:5173`) or at the Caddy/nginx
front end from the sections above instead of at Core.

## Client addresses

Core resolves the visitor's address from the socket peer, and believes an
incoming `X-Forwarded-For` only when that peer is loopback (a same-host proxy)
or listed in `FICUS_TRUSTED_PROXY_ADDRESSES`. The proxy in front of Core must
therefore send exactly one trustworthy `X-Forwarded-For`: the address it
verified itself, never a client-supplied chain. Local apps receive that one
address as their only `X-Forwarded-For`; Core strips every other
client-address header (`CF-Connecting-IP`, `True-Client-IP`, `X-Real-IP`,
`Forwarded`, and similar) before forwarding.

Behind Cloudflare with Caddy, trust only Cloudflare's published ranges
(<https://www.cloudflare.com/ips/>) and send Caddy's verified address:

```caddyfile
{
  servers {
    trusted_proxies static 173.245.48.0/20 2400:cb00::/32 # ...every published range
    trusted_proxies_strict
    client_ip_headers X-Forwarded-For
  }
}

ficus.example.com {
  reverse_proxy 127.0.0.1:3000 {
    header_up X-Forwarded-For {client_ip}
  }
}
```

Without Cloudflare (or another proxy) in front, leave `trusted_proxies` out: Caddy
then sends the connecting address. The hosted setup scripts render this
(`render_caddyfile` in `scripts/setup/lib.sh`). With nginx, use
`proxy_set_header X-Forwarded-For $remote_addr;` together with the realip module
(`set_real_ip_from` for each trusted range, `real_ip_header X-Forwarded-For`,
`real_ip_recursive on`) rather than `$proxy_add_x_forwarded_for`, which passes the
client's own claims on.

## Streaming (SSE) and buffering

Chat replies stream from `POST /api/chat` as Server-Sent Events. Core sets `X-Accel-Buffering: no` and `Cache-Control: no-transform` on the response so proxies forward tokens in real time instead of buffering the whole turn and releasing it in one burst.

- **Caddy** and **Traefik** don't buffer streamed responses by default — the configs above stream correctly with no change.
- **nginx** honors `X-Accel-Buffering: no` per response, so it also streams correctly as configured. If a proxy in front of nginx strips that header, disable buffering for the API location explicitly:

  ```nginx
  location /api/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_buffering off;          # don't buffer SSE responses
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
  ```

The tell-tale of a buffering proxy: a client (mobile or web) shows nothing during a turn, then the whole reply appears at once when the stream closes. See [Mobile App → Streaming](mobile-app.md#streaming).
