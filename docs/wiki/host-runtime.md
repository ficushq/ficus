# Host sandbox runtime (`FICUS_SANDBOX_RUNTIME=host`)

No sandbox. Agent `bash`, file tools, terminals and local deployments run
directly on the machine the core runs on, as the core's unix user, with
whatever that machine has installed. Pick this for a personal machine or a
trusted single-user VM; pick docker/k8s/vm when you need isolation. See
[sandbox-runtimes.md](sandbox-runtimes.md) to compare all five runtimes.

## Enable

Put this in `.env` and restart the api + worker (setup toolkit: `runtime.sandbox: host`):

```bash
FICUS_SANDBOX_RUNTIME=host
```

Prerequisites: `bash`, plus `tmux` on the machine if agents run local deployments. No Docker.

## Local service supervision

Fresh `bun run setup` installs use launchd on macOS and systemd user services on Linux; PM2 is still available with `--supervisor pm2`. The explicit choice is stored in registry version 3 at `~/.tau/cli/local-server.json`, and every `ficus server start|stop|restart|status|logs|update|uninstall` command dispatches from that record rather than guessing from the host.

LaunchAgents live in `~/Library/LaunchAgents` and return at the next GUI login, but do not remain alive after logout. Linux units live in `${XDG_CONFIG_HOME:-~/.config}/systemd/user`; setup attempts unprivileged linger enablement and prints `sudo loginctl enable-linger <user>` guidance when required. Native stdout/stderr share private component logs at `~/.tau/logs/<process>.log`, selected through the existing file system-log provider.

Never change a registered checkout in place. Run `ficus server uninstall --root <checkout>` and then `bun run setup -- --supervisor <new>`; uninstall retains the checkout, logs, data, and PostgreSQL resources.

## What agents see

| Area            | Path                                                                               |
| --------------- | ---------------------------------------------------------------------------------- |
| private dir     | `<HOME_DIR>/private/<sandboxId>` (bash starts here)                                |
| squad workspace | `squads.host_workspace_path` if set, else `<HOME_DIR>/workspaces/squads/<squadId>` |
| squad memory    | `<HOME_DIR>/memory/<squadId>`                                                      |

`HOME_DIR` defaults to `~/.tau`. These are the same directories every other
runtime mounts into its sandbox, so nothing is copied.

## Environment

Agent shells never inherit the core's process env. At first use the core
snapshots the user's login shell (`$SHELL -l`) from an identity-only seed
(HOME, USER, SHELL, TERM, LANG, TZ, TMPDIR) and uses that as the base — so
your PATH and profile exports apply, and the core's secrets do not. A change
to your profile needs a core restart. Each command also gets a `ficus` shim on
PATH (`<HOME_DIR>/host/bin`) and, for squads, `GIT_SSH_COMMAND` pointing at the
squad's ssh config plus the squad's `.tau/.env` sourced from the storage
workspace.

For squads, `FICUS_SQUAD_SSH_DIR` names the squad's SSH directory, and `ssh`,
`scp`, and `rsync` on PATH are ficus shims that transparently use that config
when — and only when — every remote destination is a ficus-managed
remote-host alias and no explicit `-F`/`-e`/`--rsh` was given; anything
else is passed through to the operator's own ssh untouched (an explicit
`-e`/`--rsh` still wins over the shim's `RSYNC_RSH` by rsync's own
precedence). The shims only ever ADD the squad config and pinned
`known_hosts` — host-key checking is never weakened, and commands naming
operator destinations stay byte-identical. Aliases a squad user adds to
the _user_ section of the squad config are not auto-resolved by the shims —
`ssh -F "$FICUS_SQUAD_SSH_DIR/config" <alias>` still works for those. At
worker boot, ficus re-materializes every granted squad's SSH config once
(idempotently), so grants made before a host-mode switch keep working.

### Agent identity

An agent shell is one the runtime gave a scoped token. Those shells get:

| Variable              | Value                                                                      |
| --------------------- | -------------------------------------------------------------------------- |
| `FICUS_API_URL`       | This instance, `http://127.0.0.1:<PORT>` — never another one               |
| `FICUS_TOKEN`         | The agent's own scoped token                                               |
| `FICUS_AUTH_STORE`    | `<HOME_DIR>/host/cli-auth/<agentId>.json` (`anonymous.json` with no agent) |
| `FICUS_AGENT_CONTEXT` | `1`                                                                        |
| `FICUS_AGENT_ID`      | That agent's id, passed by the runner (not guessed from the sandbox id)    |

Shells the runtime does NOT give a token — web terminals, `exec`, anything the
sandbox manager spawns — are operator-driven and unchanged: they keep your
`~/.tau/cli/auth.json` and your `ficus` behaves exactly as it does in any other
shell of yours.

What is actually enforced for an agent shell:

- **The identity is re-asserted after the squad `.tau/.env` is sourced.** That
  file is sourced INSIDE the shell, after the process env exists, so it used to
  win. The preamble now snapshots the injected values into shell-local names
  BEFORE the source line, sources the file, then exports the identity from the
  snapshots. The values travel in the process env (under `FICUS_IDENTITY_*`
  names), never in the command string, which is world-readable argv.
- **The snapshot names are generated per command** (`__ficus_<random>_url`, …),
  so a squad env cannot name them in advance — neither the real names, nor the
  `FICUS_IDENTITY_*` aliases, nor the snapshots themselves can be reached by a
  variable someone left in a squad env.
- **Identity names the shell was not given are unset** after sourcing, so a
  stale squad env cannot hand a credential to a shell that has none. That
  includes `FICUS_PASSWORD`, which an agent shell is never given: the CLI accepts
  it as a human credential, so an operator's own shell profile — or a squad env
  written before these keys were reserved — would otherwise hand the instance
  password to every agent.
- **The shim directory is re-prepended to `PATH`** after the squad env is
  applied. Squad-env PATH additions are honoured — `PATH=$PATH:/opt/toolchain`
  is a supported thing to write — but they cannot displace `ficus`, which always
  resolves to `<HOME_DIR>/host/bin/ficus`.
- **Reserved keys are rejected at write time** — see
  [Reserved squad env keys](#reserved-squad-env-keys) — and are also filtered
  out of Secret Store rendering, so a Secret Store key literally named
  `FICUS_API_URL` cannot reach `.tau/.env` either.
- **A per-agent CLI auth store.** Host agents run as your unix user with your
  `$HOME`, so without `FICUS_AUTH_STORE` the `ficus` CLI falls back to
  `~/.tau/cli/auth.json` — YOUR login, against whatever instance you last
  logged into. Each agent gets its own store path instead; the file is not
  created, and a missing store reads as empty. With `FICUS_AGENT_CONTEXT=1` the
  CLI resolves the API URL and credential from the env ONLY: no auth store, no
  `.env` fallback, and `--backend` is refused. A missing `FICUS_API_URL`/
  `FICUS_TOKEN` is an error when a command needs the credential — never a fall
  back to a human login — while `ficus whoami` and `ficus auth status` still report
  which variable is missing.

Run `ficus whoami` in any shell to see which instance it talks to and as whom.

**Standing limits.** The above closes the ACCIDENT: no squad env variable, no
stale value and no Secret Store name can reach an agent's identity or its `ficus`
by mistake. It is not a security boundary, and host mode does not have one:

- `.tau/.env` is executed as shell, not parsed. A squad env written
  specifically to defeat the preamble is still shell code running in the
  agent's own shell.
- There is no isolation on host at all. An agent that deliberately reads
  `~/.tau/cli/auth.json` (or the password file, or your gh token) can act as
  you no matter what the preamble does.

Use docker/k8s/vm when the deliberate case must be covered too.

### Reserved squad env keys

A squad env (`ficus squad-env set`, or the squad's Environment settings) may not
assign `FICUS_TOKEN`, `FICUS_API_URL`, `FICUS_PASSWORD`, `FICUS_AUTH_STORE`,
`FICUS_AGENT_CONTEXT`, `FICUS_AGENT_ID`, or the `FICUS_IDENTITY_API_URL`,
`FICUS_IDENTITY_TOKEN`, `FICUS_IDENTITY_AUTH_STORE` and `FICUS_IDENTITY_AGENT_ID`
aliases: the agent's identity is injected by ficus, and setting it there would
make every agent in the squad act as a different identity. Writes naming one
are rejected with a 400 naming the key and the reason, and the same names are
filtered out of Secret Store exposure rendering.

`PATH` is deliberately NOT reserved — adding to it is a legitimate squad env —
because the shim re-prepend above already keeps `ficus` pointing at ficus's own CLI.

Values stored before this rule are not migrated; the re-assertion above is what
stops them taking effect.

## Security model

- The login-shell snapshot runs `$SHELL -l -c`, so anything exported from the
  operator's LOGIN files (`~/.zprofile`/`~/.zlogin`/`~/.profile`, plus their
  system-wide counterparts) DOES reach agent shells. `~/.zshrc` is not part of
  that snapshot — it is sourced only by the interactive shells the terminal
  spawns. The guarantee is "no core-process secrets", not "no secrets".
- There is no cross-agent isolation on host: every squad agent and
  `squad_bash` run as the same unix user on one filesystem, so an agent's
  private dir (`<HOME_DIR>/private/<sandboxId>`) is readable by every other
  agent on the instance. Squad agents are mutually trusted by design; use
  docker/k8s/vm when that is not acceptable.

## Per-squad workspace override

Choose a working directory while creating a squad in the web create modal or
onboarding flow, or pass `--host-workspace-path /abs/dir` to `ficus squad create`.
For an existing squad, use `ficus squad update <id> --host-workspace-path
/abs/dir` or the squad's Settings → Workspace section in the web UI. Updates take effect at
the squad's next sandbox start. Ficus creates the directory if missing and never
deletes it — archive-with-delete only removes the default storage directory.

## Browser tools

`browser_open` and friends work on host. There is no box to run the
`tau-browser` service in, so the core drives a browser **already installed on
this machine** in-process, through `playwright-core` — nothing is ever
downloaded. Install one first: macOS `brew install --cask google-chrome` (or
Chrome from <https://google.com/chrome>); Debian/Ubuntu `sudo apt install
chromium`; Fedora `sudo dnf install chromium`; or point Ficus at any
Chromium-family binary with `FICUS_BROWSER_EXECUTABLE_PATH`. With none of them
present the tools answer "Browser is unavailable on this machine."

Resolution order, first hit wins:

1. `FICUS_BROWSER_EXECUTABLE_PATH` — an absolute path to the executable FILE, not
   to a bundle or directory. A leading `~` is expanded to your home directory
   before that check. On macOS that means
   `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, not
   `/Applications/Google Chrome.app`. Anything else is ignored with a warning.
2. `FICUS_BROWSER_CHANNEL` — a Playwright channel (`chrome`, `chrome-beta`,
   `chrome-dev`, `chrome-canary`, `msedge`, `msedge-beta`, `msedge-dev`,
   `msedge-canary`, `chromium`).
3. The usual install locations: Google Chrome / Chromium / Edge / Brave under
   `/Applications` on macOS, `/usr/bin/google-chrome-stable`,
   `/usr/bin/chromium`, `/usr/bin/microsoft-edge`, … plus any
   Playwright-managed Chromium under `/opt/tau/browser/ms-playwright` or
   `~/.cache/ms-playwright` on Linux. `/snap/bin/chromium` is skipped — snap
   confinement breaks the temporary profile Playwright hands it.

Security: the browser runs headless, as the core's unix user, on the core's
network. Chromium's own renderer sandbox stays ON (it is dropped only when the
core itself runs as root, which Chrome refuses to start under) — it is the one
isolation boundary between a hostile page and this machine. The browser
process only inherits a narrow allowlisted environment (display/locale
basics plus `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` and their lowercase forms)
so a core running behind a proxy keeps browser egress; every other env var,
including secrets, is stripped.

On host the browser is NOT subject to the machine-host SSRF blocklist: it can
reach `localhost`/loopback, link-local (incl. cloud-metadata addresses) and
private LAN addresses exactly like the agent's `bash` can on this machine. That
blocklist exists on machine hosts because there `tau-browser` is a shared
service whose network reach exceeds the calling box's; here it is your own
machine and your own network, so the guard would protect nothing while breaking
the main reason to browse from host — screenshotting the agent's own local
deployment, including Ficus's own `http://localhost:<port>/api/app/<id>/…`
proxied URLs. Non-`http(s)` URLs (`file://`, …) are still refused.

Each agent gets its own browser context, so cookies, storage and logins are not
shared between agents — but they are not isolated from each other beyond that
(same as everything else on host). Set `FICUS_BROWSER_MEMORY_HIGH_MB` to change
the page budget (default: a quarter of this machine's RAM, capped at 4 GB,
~256 MB per page — the core and your desktop share this RAM).

## Workspace memory watch

`squad.memoryConfig.workspacePaths` works on host exactly like on the
container runtimes. The core watches the squad's workspace (the override
directory when one is set, else `<HOME_DIR>/workspaces/squads/<squadId>`) and
feeds file changes into the same memory ingest path the sandbox-callback
route uses, so edits produce identical memory events.

Differences from containers, both because there is no container filesystem
boundary:

- One watcher per squad per machine. Core runs as two processes (api +
  worker); whichever ensures the squad first wins a lock file under
  `<HOME_DIR>/watch-locks/` and watches — the other defers. The lock is a
  kernel flock, so it is released when the owning process dies, never stale.
- Include/exclude globs must stay inside the workspace: patterns containing
  `..` segments are rejected. Symlinked files are skipped on live events.

Stopping the squad sandbox or disabling `memoryConfig` stops the watcher;
member-agent sandboxes never do.

## Not available on host

- devbox / managed toolchains (a configured squad toolchain is ignored with a warning)
- container log streaming

Local deployments need `tmux` on the machine.
