# Ficus Desktop runtime contract

Ficus Desktop provides the Electron shell, onboarding and native process supervision. Core remains a separately built, pinned artifact; Desktop never starts a mutable checkout for a managed installation.

The native artifact builder supports `linux-x64` and `darwin-arm64` on their matching build hosts. It includes API, worker, migrations, web assets, CLI, configuration and runtime dependencies, including `playwright-core` and the native `bun-pty` distribution. Linux machine bundles remain Linux artifacts for remote machine use.

Desktop provides `FICUS_ROOT` for immutable resources and `HOME_DIR` for mutable user data. It sets `FICUS_DESKTOP_MANAGED=1`, which disables Core's checkout updater. All API, worker and internal-event listeners bind loopback. Independent database, encryption, bootstrap and event credentials remain in private local configuration. Desktop configures `VAPID_KEYS_PATH` in the data home and the file system-log provider so startup neither writes inside the app bundle nor probes/starts PM2.

`GET /health` remains liveness and never touches the database. `GET /health/db` runs `select 1` with a 2-second limit and returns 200 `{status:"ok",database:"ok"}` or 503 `{status:"error",database:"unreachable"}` (never the underlying error), for monitors that need to know database-backed requests can succeed. `GET /ready` returns HTTP 503 during initialization or shutdown and HTTP 200 only after startup completes. The body contains `service`, `ready`, and the optional `FICUS_RUNTIME_INSTANCE_ID` launch identifier. Desktop checks all three before opening the app or starting dependent services. This is public process identity, not authentication or proof of local user authority.

`FICUS_MACHINE_CONTROL_DIR` optionally supplies an absolute directory for transient machine control sockets. Desktop creates a private, short, per-launch directory because macOS Unix socket limits can be exceeded by a long selected home. API and worker share this directory; Desktop removes it only after both processes stop.

### Application address contract

Desktop declares where this Core is reachable from the local machine with `FICUS_LOCAL_APP_URL=http://localhost:<apiPort>`. It is a **default, not an override**: Core uses it as the application address only when neither `APP_URL`/`PUBLIC_URL` nor the administrator-set public address (Settings → Administration → Server address) exists; it never locks that setting; it is always an allowed browser origin for CORS, CSRF and WebSocket checks; session cookies for requests addressed to its host are `SameSite=Lax` and `Secure` only over HTTPS (so localhost login keeps working after an HTTPS public address is set); and Settings shows it as the **Local address**.

Launchers that want the public address to be editable must **not** set `APP_URL`, `PUBLIC_URL`, `FICUS_WEB_ORIGIN` or `WEBAUTHN_ORIGIN`. Keep `FICUS_API_URL`, `HOST`, `PORT` and the worker/event variables unchanged. Pass `FICUS_LOCAL_APP_URL` only with a bundled Core that supports it; older Cores ignore it. While a launcher still sets `APP_URL`, Settings shows the address as set by the server environment and, with `FICUS_DESKTOP_MANAGED=1`, tells the user to update Ficus Desktop.

When the Desktop bridge offers `signInWithBrowser(): Promise<void>`, the existing passkey login page also shows **Sign in with browser** as a secondary backup. **Sign in with Passkey** remains first and primary. The optional bridge method accepts no URL or credentials: Desktop validates the calling instance window, owns the configured server destination, and handles approval and encrypted device-token storage. The web app does not start browser approval automatically, including after a failed passkey attempt; browsers and older Desktop builds without this capability keep the existing login UI.

Authentication remains Core's normal first-admin bootstrap and passkey flow. Localhost is not an authorization bypass. Desktop may pass its generated first-admin credential through the existing immediately stripped `#setup=` fragment; the setup IPC API never returns that secret. Existing installations retain their configured origins, databases, supervisors, authentication and home paths.

Desktop-managed host agents run as the signed-in OS user and have filesystem access. The UI must explain that boundary. Browser automation still requires a supported locally installed Chromium browser; embedding Electron does not install a Playwright browser.

## Verifying the bundled Core

Desktop is closed source, so nothing it says about itself is the proof. The Core it bundles is built in public: `.github/workflows/desktop-core.yml` builds the `darwin-arm64` artifact for every `main` commit on a GitHub-hosted runner and attests it (Sigstore build provenance: this archive, with this digest, was built by this workflow from this commit). The Desktop release workflow bundles exactly that archive and publishes it, with its attestation bundle, next to the app download.

`ficus desktop verify [path/to/Ficus.app]` checks an installed app against it:

1. The app is signed by the Ficus Developer ID team and unmodified since (`codesign --verify --deep --strict`).
2. The Core archive for the app's bundled commit has a valid attestation from that workflow, on `refs/heads/main`, for that exact commit, from a GitHub-hosted runner (`gh attestation verify`; the GitHub CLI is required).
3. Every file in the app's `Contents/Resources/core` is byte-identical to the archive. Native binaries are the exception: packaging re-signs them with the Developer ID, so they must match once the signature is removed, with only `__LINKEDIT`'s vmsize (grown by signing, a memory-layout field) taken from the original. Files the app leaves out are fine; a file the archive lacks fails.
4. Bun, which runs Core, matches Bun's official release (checked against Bun's published `SHASUMS256.txt`) in the same way.

It does not cover PostgreSQL (repackaged from Postgres.app) or the Desktop shell itself, which starts Core and holds your sign-ins; the report says so. Releases before the attested archive was published cannot be checked.

## Web app bridge

The web app detects the desktop preload bridge (`window.ficusDesktopApp`, `version: 1`; builds released before the rename expose it as `window.tauDesktopApp`, which the web app still reads when the new name is absent). Members added after the first release are optional and feature-detected individually, so older and newer desktop builds degrade gracefully:

- `updates` replaces the git updater on Settings → Updates with the app's native update status and **Restart to update**.
- `setNotificationsEnabled` adds the **Desktop notifications** switch to Settings → Notification Rules (see [Desktop notifications](desktop-notifications.md)).
- `shell.insetTitleBar` marks the document `data-desktop-shell="inset"` while the window is not fullscreen. The app header then becomes the title bar: 56px tall, a window drag region with interactive controls and overlays excluded, and the logo kept clear of the window controls. Browsers never receive the mark.
- `instance` reports which kind of Ficus Desktop window this is: `{ kind: 'local' | 'attached' | 'remote', name, disconnect? }`. `local` is the bundled runtime Desktop manages itself; `attached` is a local install Desktop points at without managing; `remote` is a paired instance reached over the network. `disconnect()` is only present when the window can unpair itself from that instance.
- `notificationsPolledByShell` tells the web app the shell already delivers notifications on its own (see [Desktop notifications](desktop-notifications.md)), so the web app must not also poll.

The bridge's presence also changes some web app behavior:

- An invite link for a pending admin in **Settings → Users** also offers **Open in Ficus**. It opens passkey setup in the current window, because a passkey created in an external browser cannot be used in the desktop app. Links for other invitees are copied as usual.
- With no stored theme choice, the app follows the operating system's light or dark appearance, like the desktop app's own setup screens. A choice made in **Settings** or on the setup page still wins. Browsers keep the light default.
- `instance.kind` decides how Settings → Updates behaves: only `local` (or a build too old to report `instance` at all) gets the native Desktop update panel; `attached` and `remote` instances keep the ordinary git updater section, because they update like any other server.
- A `remote` instance with `disconnect` swaps the Settings → Account **Logout** row for **Disconnect this Mac from `<name>`**, which calls `instance.disconnect()` instead of signing out. Any other instance kind, or a `remote` instance without `disconnect`, keeps the normal Logout row.
- When `instance` is present, its `name` appears next to the logo in the app header, visible only in the desktop inset title bar, so a person can tell which instance a given window is showing.

## Desktop navigation history

The existing app header includes **Go back** and **Go forward** arrows after the
macOS window controls. **Cmd+[** and **Cmd+]** use the same history, in windowed
and fullscreen mode. Disabled directions are safe no-ops. Editor handlers that
consume a shortcut take precedence; the web handler prevents the native default
for handled keys. The desktop menu does not register competing bracket accelerators.
Ordinary browser/mobile headers and keyboard handling are unchanged.

The web app uses Chromium's Navigation API to inspect real session-history
entries, then traverses with `history.go` so React Router receives its normal
pop events. Paths, queries, and hashes participate; replacements do not add an
entry, and new navigation after going back discards the forward branch. There is
no separate route stack and no new preload bridge requirement.

Only adjacent entries observed by this app/window are reachable. Entry keys and
IDs (not URLs or chat contents) are saved in origin-scoped session storage under
the app's base path, preserving availability on reload. Unknown entries, other
origins/base paths, and entries replaced by unrelated documents form boundaries.
If storage is unavailable, history still works within the current document but
reload starts a new boundary. Desktop clients without the Navigation API show
disabled arrows rather than guessing from `history.length`; current Desktop's
Chromium provides the API. New windows start their own session history.

Focused verification: from `apps/web`, run `bun test src/lib/desktopHistory.test.ts`
and `CHROMIUM_PATH=/path/to/chromium bun scripts/check-desktop-history.ts`.
The latter exercises the real header, stylesheet, Router, and Chromium history
without a backend. It simulates the desktop bridge; actual macOS traffic lights,
window dragging, and native keyboard delivery still require a Desktop check.
