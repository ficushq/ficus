# Ficus Desktop runtime contract

The private `ficushq/tau-desktop` repository owns Electron, onboarding and native process supervision. Core remains a separately built, pinned artifact; Desktop never starts a mutable checkout for a managed installation.

The native artifact builder supports `linux-x64` and `darwin-arm64` on their matching build hosts. It includes API, worker, migrations, web assets, CLI, configuration and runtime dependencies, including `playwright-core` and the native `bun-pty` distribution. Linux machine bundles remain Linux artifacts for remote machine use.

Desktop provides `FICUS_ROOT` for immutable resources and `HOME_DIR` for mutable user data. It sets `FICUS_DESKTOP_MANAGED=1`, which disables Core's checkout updater. All API, worker and internal-event listeners bind loopback. Independent database, encryption, bootstrap and event credentials remain in private local configuration. Desktop configures `VAPID_KEYS_PATH` in the data home and the file system-log provider so startup neither writes inside the app bundle nor probes/starts PM2.

`GET /health` remains liveness. `GET /ready` returns HTTP 503 during initialization or shutdown and HTTP 200 only after startup completes. The body contains `service`, `ready`, and the optional `FICUS_RUNTIME_INSTANCE_ID` launch identifier. Desktop checks all three before opening the app or starting dependent services. This is public process identity, not authentication or proof of local user authority.

`FICUS_MACHINE_CONTROL_DIR` optionally supplies an absolute directory for transient machine control sockets. Desktop creates a private, short, per-launch directory because macOS Unix socket limits can be exceeded by a long selected home. API and worker share this directory; Desktop removes it only after both processes stop.

Authentication remains Core's normal first-admin bootstrap and passkey flow. Localhost is not an authorization bypass. Desktop may pass its generated first-admin credential through the existing immediately stripped `#setup=` fragment; the setup IPC API never returns that secret. Existing installations retain their configured origins, databases, supervisors, authentication and home paths.

Desktop-managed host agents run as the signed-in OS user and have filesystem access. The UI must explain that boundary. Browser automation still requires a supported locally installed Chromium browser; embedding Electron does not install a Playwright browser.

## Web app bridge

The web app detects the desktop preload bridge (`window.tauDesktopApp`, `version: 1`). Members added after the first release are optional and feature-detected individually, so older and newer desktop builds degrade gracefully:

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
