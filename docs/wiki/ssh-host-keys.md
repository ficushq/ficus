# SSH Host Keys for Core's Own Connections

Every SSH connection Core makes checks the server's host key strictly against
keys a person confirmed. Nothing trusts a key on first use. Remote hosts use
the model in [Remote hosts](remote-hosts.md); this page covers the other
endpoints, which share the same model and UI:

| Endpoint                         | Scope                               | Who decides (people only)             |
| -------------------------------- | ----------------------------------- | ------------------------------------- |
| BYO machine                      | `machine:<id>` (kind `machine`)     | `machines:write`, Settings > Machines |
| exe.dev VM                       | `machine:<id>` (kind `exe-machine`) | `machines:write`, Settings > Machines |
| exe.dev API (`ssh exe.dev ...`)  | `exe-api`                           | `machines:write`, Settings > Machines |
| Squad memory git remote over SSH | `memory-git:<squadId>:<host>`       | squad `memory:write`, Memory settings |

Code: `apps/core/src/services/ssh-trust/` (tables `ssh_trust_targets`,
`ssh_trust_keys`), API `apps/core/src/routes/ssh-host-keys.ts`, web
`apps/web/src/components/settings/SshHostKeysList.tsx`.

## Lifecycle

- **First connection to a new endpoint**: Core fetches its keys with
  `ssh-keyscan` (no login) and stores them as `pending`. The connection is
  refused with a message naming where a person confirms the key.
- **Trust / Reject**: a signed-in person compares the SHA256 fingerprint with
  the one on the server and trusts or rejects it. Agents, system tokens and the
  ownerless bootstrap session are refused on these routes whatever their
  permissions. Fetching keys is allowed to anyone who may manage the endpoint;
  it never trusts a key.
- **Key change**: a fetch that sees a different key of a trusted type records it
  as pending and shows it as a key change. Connections keep using the trusted
  key, so a server that really changed its key is refused until a person
  trusts the new one.
- **exe.dev**: every exe.dev VM is reached through exe.dev's SSH proxy. A new
  VM whose fetched key is identical to a key already trusted for another exe.dev
  endpoint is trusted as that key (origin `provider-key`); any other key waits
  for a person. BYO machines never get this shortcut.

## Connecting

Core writes the endpoint's trusted keys to `<HOME_DIR>/ssh-trust/<hash>.known_hosts`
(0600) under a per-endpoint `HostKeyAlias` (`ficus-trust.<hash>`) and passes, on
the command line:

```
-o StrictHostKeyChecking=yes -o UserKnownHostsFile=<pin file>
-o GlobalKnownHostsFile=/dev/null -o HostKeyAlias=<alias>
-o UpdateHostKeys=no -o VerifyHostKeyDNS=no -o CheckHostIP=no
```

Command-line options beat every ssh_config file, so no config (the Core user's
or a squad's) can relax them. Machine runs, streams and ControlMaster tunnels
(`machines/ssh.ts`, `machines/tunnel-manager.ts`), exe.dev API calls
(`machines/providers/exe-api.ts`) and memory git (`GIT_SSH_COMMAND` in
`memory/sync/GitAdapter.ts`) all resolve this pin before connecting; an endpoint
without a trusted key is refused before any connection is attempted. Memory git
over HTTPS gets an ssh command that always fails.

## Rollout

The migration (`0221_ssh_trust_keys.sql`) creates an adopting endpoint for
every existing machine, for exe.dev when exe machines exist, and for each SSH
memory git remote in squad sync configs. On first use each adopts the key Core
already trusted under `accept-new`, with no prompt (origin `adopted`, no
deciding person):

- machines and exe.dev VMs: `<HOME_DIR>/machines/known_hosts`;
- exe.dev API: the Core user's `~/.ssh/known_hosts` (that ssh call named no file);
- memory git: the squad ssh dir's `known_hosts`.

Two different keys of one type are not picked: both wait for a person. No key
found: fetched and pending like a new endpoint.

## Box bootstrap

The forwarding self-test in `scripts/machine/bootstrap.sh` ssh-es from the
machine to its own sshd on `127.0.0.1`. It pins the host keys read from
`/etc/ssh/ssh_host_*_key.pub` and checks strictly; without a readable host key
the self-test reports "could not run" instead.

## Squad ssh_config

Squad boxes reach remote hosts through the squad's own ssh config. The managed
remote-host block is written first in that config, so a squad `Host *` stanza
cannot relax checking for a managed host; see
[Remote hosts § The Managed-Block Contract](remote-hosts.md#the-managed-block-contract).

## Installer (`scripts/setup/`)

The operator-run installer runs before Core exists, so it pins keys itself:
exe.dev by its published fingerprint, a new Hetzner or DigitalOcean server by a
host key the installer generates and installs through cloud-init, and the
git-ssh clone by GitHub's published keys (`scripts/setup/github_known_hosts`).
A server with no out-of-band key needs an operator to confirm its fingerprint
(or `--host-key-fingerprint` for a non-interactive run). See
[the setup README](../../scripts/setup/README.md#ssh-host-keys). The guard test
(`services/ssh-trust/no-trust-on-first-use.test.ts`) scans `scripts/` too, with
no exceptions.
