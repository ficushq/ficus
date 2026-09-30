# Ficus CLI Documentation

For configurable squads, lazy participants, parallel flows, scoped waits, and delivery policies, see [Workflows, flows, and squads](../workflows.md).

The `ficus` CLI is the primary interface for interacting with the Ficus API. It covers agent management, squads, work streams, scheduling, secrets, and more.

## Installation & Usage

`ficus.js` is a self-executable script (has a shebang line) — no wrapper script needed. It is installed on `PATH` in both the **core Docker image** and **sandbox pods**, so agents can use `ficus` directly inside their sandbox to interact with the API.

## Environment Variables

| Variable           | Description                                                                                       | Default                 |
| ------------------ | ------------------------------------------------------------------------------------------------- | ----------------------- |
| `FICUS_API_URL`    | URL of the Ficus API server                                                                       | `http://localhost:3000` |
| `FICUS_TOKEN`      | Scoped agent token or other explicitly supplied token                                             | —                       |
| `FICUS_PASSWORD`   | Explicit human credential; legacy `/etc/tau/password` fallback applies only outside agent context | —                       |
| `FICUS_AUTH_STORE` | Override path for labeled CLI backends (default `~/.ficus/cli/auth.json`)                         | —                       |
| `FICUS_SQUAD_ID`   | Default squad context for squad-scoped commands                                                   | —                       |

Outside agent context, the CLI can use labeled backends saved by `ficus auth login`, explicit environment credentials, and legacy `.env` or mounted-password fallbacks. See `ficus auth status` and [Core authentication](../core-auth.md) for the current login model.

Inside a shell Ficus built for an agent — one it gave a scoped token — the runtime sets `FICUS_AGENT_CONTEXT=1`
(plus `FICUS_AGENT_ID`, `FICUS_TOKEN`, `FICUS_API_URL` and a per-agent
`FICUS_AUTH_STORE`). There, resolution is env-only: the auth store, the `.env`
fallback and `/etc/tau/password` are never consulted and `--backend` is refused,
so no ambient operator login can be picked up by accident. On the host runtime
that closes the accident, not the deliberate case — see
[agent identity and its standing limits](../host-runtime.md#agent-identity). Run `ficus whoami` to see
which instance a shell talks to and as whom.

## Global Options

```bash
ficus --json     # Output in JSON format
ficus --quiet    # Minimal output
ficus --backend <label>  # Select a saved backend for this command (outside agent context)
```

## Command Groups

| Command                     | Alias   | Description                           |
| --------------------------- | ------- | ------------------------------------- |
| `ficus agent-type`          | `at`    | Manage agent types                    |
| `ficus agent`               |         | Manage agents                         |
| `ficus worker`              |         | Manage workers                        |
| `ficus chat`                |         | Chat with your User Assistant         |
| `ficus image`               |         | Manage images                         |
| `ficus action`              |         | Manage actions                        |
| `ficus webhook`             |         | Manage webhooks                       |
| `ficus squad`               |         | Manage squads                         |
| `ficus slot`                |         | Coordinate squad capacity slots       |
| `ficus squad-preset`        | `st`    | Manage squad presets                  |
| `ficus workstream`          | `ws`    | Manage work streams                   |
| `ficus schedule`            |         | Manage schedules                      |
| `ficus inbox`               |         | Manage inbox                          |
| `ficus memory`              |         | Manage agent memory                   |
| `ficus discord`             |         | Discord integration                   |
| `ficus secret`              |         | Manage secrets                        |
| `ficus squad-env`           |         | Manage squad environment variables    |
| `ficus channel`             | `ch`    | Manage channel instances              |
| `ficus notification-config` | `notif` | Manage notification config            |
| `ficus provider-auth`       | `pa`    | Manage AI provider credentials        |
| `ficus system`              |         | System management                     |
| `ficus whoami`              |         | Show this shell's instance + identity |

Other current command groups include:

| Command                                  | Description                                                                      |
| ---------------------------------------- | -------------------------------------------------------------------------------- |
| `ficus auth`                             | Log in, switch backends, inspect identity, and log out                           |
| `ficus search <query>`                   | Search squads, work streams, consultant chats, and saved Assistant conversations |
| `ficus integration`                      | Connect, inspect, and assign external integrations                               |
| `ficus workflow`                         | Manage presets, preview flows, and advance or finish flow runs                   |
| `ficus agent-question` (`aq`)            | Manage asynchronous agent questions                                              |
| `ficus deploy`                           | Manage local app runs and external deployment records                            |
| `ficus skill` (`skills`)                 | Manage bundled and dynamic agent skills                                          |
| `ficus shared-prompt` (`shared-prompts`) | Manage shared prompts included by agent types                                    |
| `ficus remote-hosts`                     | Manage team-owned SSH hosts                                                      |
| `ficus amtp` / `ficus remote`            | Manage federation and agent federation identity                                  |
| `ficus machines`                         | Manage VM sandbox machines                                                       |
| `ficus monitor`                          | Read or cancel agent-owned monitors                                              |
| `ficus user` / `ficus role`              | Read users, role assignments, effective permissions, and role definitions        |
| `ficus server`                           | Manage the instance installed on this machine                                    |
| `ficus install` / `ficus update`         | Install the CLI or update an instance                                            |
| `ficus admin`                            | Operator maintenance actions                                                     |

Run `ficus --help` and `ficus <command> --help` for the complete current options.

## Detailed Documentation

| Document                                          | Description                                          |
| ------------------------------------------------- | ---------------------------------------------------- |
| [Squad System Overview](squad-system-overview.md) | High-level overview of the squad system architecture |
| [Squad Commands](squad-commands.md)               | Reference for common `ficus squad` commands          |
| [Work Stream Commands](workstream-commands.md)    | Complete reference for `ficus workstream` commands   |

## Quick Reference

### Squad Commands

```bash
ficus squad list              # List all squads
ficus squad create <name>     # Create a new squad
ficus squad get <id>          # Get squad details
ficus squad update <id>       # Update a squad
ficus squad delete <id>       # Archive a squad, preserving history
ficus squad agents <id>       # List agents in squad
ficus workstream list --squad <id>  # List work streams for a squad
ficus squad spawn <type> <id> # Spawn agent in squad
ficus squad link <a> <b>      # Link two squads
```

### Slot Coordination Commands

Pool-scoped commands accept `--squad <id>` and otherwise use `FICUS_SQUAD_ID`.
Claim and waiter ids are globally unique, so the commands that address one take
the id alone: the server resolves its pool and squad, and checks your authority
against that squad.

```bash
ficus slot list [key] [--squad <id>]
ficus slot history <key> [--limit <1..100>] [--cursor <opaque>] [--squad <id>]
ficus slot register <key> [--capacity <n>] [--timeout <duration>] [--squad <id>]
ficus slot update <key> [--capacity <n>] [--timeout <duration>] [--squad <id>]
ficus slot unregister <key> [--squad <id>]
ficus slot claim <key> [--no-subscribe] [--squad <id>]
ficus slot subscribe <key> [--squad <id>]
ficus slot renew <claim-id>
ficus slot release <claim-id>
ficus slot unsubscribe <waiter-id>
```

`ficus slot claim` joins the FIFO queue when no capacity is free, returning
`queued` with a waiter id, so a contended claim no longer needs a second
`subscribe` call. Pass `--no-subscribe` to get the immediate-only answer
(`unavailable`, queueing nobody). `queued` is not ownership: wait for the grant
before starting protected work.

A live queued subscription suppresses automatic work-stream continuation nudges
and idle escalation until no queued waits remain. It does not block human
steering, actual grant notifications, or other inbox work. Waiters do not expire
by age; cancellation, unsubscription, promotion, and owner/pool lifecycle end the
wait. An owned claim (including an expired claim) is not a queued subscription.

The web agent conversation shows **Queued for slots** with the current pool keys
when the viewer can read the agent and use or manage slots in its squad. Multiple
waits appear together; this is additional context, not the only possible reason
for inactivity. Status refreshes on lifecycle events and reconnect without
polling, and does not imply queue position or an estimated grant time.

Pool capacity is bounded from 1 through 1000 units. Claims expire automatically but expiry does not stop external work. When a claim times out without being released or renewed, Ficus sends its owning agent one steering inbox reminder to stop the heavy processes, containers and test databases it started under the claim and to claim again before resuming heavy work. Release claims immediately when protected work finishes. Slot commands use exit code 0 for every successfully retrieved authoritative outcome, including `unavailable`, `queued`, `expired`, and `already_released`; automation must branch on the JSON `outcome` rather than treating admission state as a transport error. Invalid input, authorization failures, and API failures exit nonzero.

`ficus slot list` prints each pool with the caller's own recovery state — a held claim with its expiry and release/renew commands, or a queued waiter with its queue time and unsubscribe command — so the identifiers needed for release, renew, and unsubscribe are directly copyable. Foreign holders stay redacted to short IDs; pass `--json` for the untouched server projection. Slot pools of an archived squad answer `410 Squad is archived`.

Ordinary slot list/detail responses omit terminal history, and acquisition JSON contains only the outcome, message, relevant claim or waiter identity, and a bounded five-field pool snapshot (`key`, `capacity`, `activeCount`, `availableCount`, and `queuedCount`). Use `ficus slot history` to read terminal claims and waiters explicitly. History is paginated by the server (50 records by default, 100 maximum); use the returned opaque cursor to continue. Ordinary agents see only their own terminal records, while callers with `slots:write` see pool-wide diagnostics.

### Work Stream Commands

Prefer a saved workflow or explicit flow for new work:

```bash
ficus workflow list
ficus workstream create "Implement account search" --squad <id> --workflow engineering
ficus workstream create "Summarize meeting notes" --squad <id> --workflow solo
```

The selected style defines participation and delivery. Participants are created lazily as their steps are reached. Every new stream uses a flow. Omit the source to use the squad default; manual staffing and completion flags are no longer accepted at creation. See [Workflows](../workflows.md) before combining creation options.

```bash
ficus ws list                 # List work streams
ficus ws create <title>       # Create work stream
ficus ws get <id>             # Get work stream details
ficus ws update <id>          # Update work stream
ficus ws request-input <id> -m "<msg>"   # Open a manual wait (--actor human|owner)
ficus ws unblock <id> -m "<note>"        # Resolve the input request
ficus ws request-review <id> -m "<msg>"  # Open the review wait (--no-complete = checkpoint gate)
ficus ws approve <id> [-m "<note>"]      # Approve review (completes the stream by default)
ficus ws send-back <id> --note "<msg>"   # Send review back with feedback
ficus ws handoff <id> --to <agent>       # Reassign to another agent
ficus ws done <id>            # Mark as complete (rejected while waits are open)
ficus ws reopen <id>          # Reopen a done/canceled stream
```

### Schedule Commands

```bash
ficus schedule list           # List schedules
ficus schedule create         # Create a schedule (supports workStream title/desc on spawn_agent action)
ficus schedule update <id>    # Update a schedule
ficus schedule delete <id>    # Delete a schedule
ficus schedule trigger <id>   # Manually trigger a schedule
ficus schedule enable <id>    # Enable a schedule
ficus schedule disable <id>   # Disable a schedule
ficus schedule show <id>      # Show schedule details
```

Schedule work using a preset or ephemeral flow. Omit the source to inherit the squad default at each run:

```bash
ficus schedule create --squad <id> --name "Daily health" --interval 24h \
  --action create_work_stream --title "Check system health" --workflow solo

ficus schedule create --squad <id> --name "Daily audit" --interval 24h \
  --action create_work_stream --title "Daily audit" --flow-content '{"kind":"preset","id":"solo"}'

ficus schedule update <id> --workflow with-review
```

The flow owns participation and delivery policy, including `pr-merge`, `pr-auto-merge`, `review-approval`, or policy-gated `direct-merge`. `spawn_agent` schedules are only for standalone agents. To migrate a stored schedule with an agent list or completion flag, select a workflow; old `spawn_agent.workStream` schedules must change to `create_work_stream`.

Schedule list/show output separates configured Enabled state from execution Health. `show` includes attempts, failure counters, recovery timestamps, and the bounded safe error/automatic-disable reason. Temporary schedules can use `--expires-at <ISO-datetime>`; update with `--clear-expires-at` to restore indefinite operation.

### Secret Commands

```bash
ficus secret list             # List all secrets (names only, no values)
ficus secret get <key>        # Get a secret value
ficus secret set <key> <val>  # Set a secret value
ficus secret delete <key>     # Delete a secret
```

### Identity

```bash
ficus whoami                  # Which instance this CLI talks to, as whom, and where that came from
ficus whoami --json           # Same, as JSON
```

### Users and Roles

Read-only; `ficus user` needs `users:read` and `ficus role` needs `roles:read`. A user is named by id, short id, or email.

```bash
ficus user list                                   # Users with state: active, invited, disabled
ficus user get <user>                             # One user and each role assignment with where it applies
ficus user permissions <user> --squad <squadId>   # Effective permissions in that squad, resolved by the server
ficus user permissions <user> --squad <squadId> --check deployments:read   # Does this user hold one permission?
ficus role list [--user-assignable]               # Roles and how many permissions each grants
ficus role get <slug>                             # Every permission one role grants
```

Instance-wide roles always apply. In a squad, the user's roles assigned on that squad replace their default-for-squads roles, so check a squad question with `ficus user permissions --squad` rather than reading assignments by hand.

### Squad Environment Commands

Squad env content may not assign the keys ficus injects to give an agent its
identity (`FICUS_TOKEN`, `FICUS_API_URL`, `FICUS_PASSWORD`, `FICUS_AUTH_STORE`,
`FICUS_AGENT_CONTEXT`, `FICUS_AGENT_ID`, `FICUS_IDENTITY_*`) — such a write is
rejected with a 400 naming the key and why. `PATH` may be extended as usual; on
the host runtime ficus re-prepends its own shim directory afterwards, so squad
PATH additions apply but cannot displace `ficus`.

```bash
ficus squad-env get <squadId>                # Get .tau/.env content for a squad
ficus squad-env set <squadId> <content>      # Set .tau/.env content (use quotes for multi-line)
ficus squad-env set-file <squadId> <path>    # Set .tau/.env content from a file
ficus squad-env secrets <squadId>            # List per-squad/global secret exposure status
ficus squad-env expose-secrets <squadId> KEY # Expose Secret Store keys to one squad
ficus squad-env global-secrets               # List globally exposed Secret Store keys
ficus squad-env expose-global KEY            # Expose Secret Store keys to all squads
ficus squad-env unexpose-global KEY          # Remove global exposure
```

### Channel Instance Commands

```bash
ficus channel list            # List all channel instances
ficus channel get <id>        # Get channel instance details
ficus channel create          # Create a channel instance
ficus channel update <id>     # Update a channel instance
ficus channel delete <id>     # Delete a channel instance
ficus channel template-diff <id>  # Show diff between config and YAML template
ficus channel revert <id>     # Revert to YAML template
ficus channel disable <id>    # Disable a channel instance
ficus channel enable <id>     # Enable a channel instance
ficus channel export <id>     # Export channel instance as YAML
```

### Notification Config Commands

```bash
ficus notif get               # Get current notification config
ficus notif set               # Update config from JSON file
ficus notif template-diff     # Show diff between config and YAML template
ficus notif revert            # Revert to YAML template
ficus notif disable           # Disable notification config
ficus notif enable            # Enable notification config
ficus notif export            # Export config as YAML
```

### Provider Auth Commands

```bash
ficus pa list                 # List all configured providers
ficus pa get <provider>       # Check auth status for a provider
ficus pa set <provider> <key> # Set an API key for a provider
ficus pa delete <provider>    # Remove auth for a provider
ficus pa oauth-providers      # List available OAuth providers
```

### System Commands

```bash
ficus system restart          # Restart the server process (K8s auto-restarts the pod)
ficus system logs             # Stream Ficus system logs (API and worker)
ficus system logs -c api -t 50 --no-follow
```

## Sandbox Usage

Ficus injects a scoped `FICUS_TOKEN`, the instance `FICUS_API_URL`, and `FICUS_AGENT_CONTEXT=1` into agent shells. The CLI authenticates as that agent and resolves credentials only from the injected environment. It does not read the operator’s saved backend, `.env` password, or `/etc/tau/password` in agent context. The mounted-password fallback remains a legacy option for non-agent CLI use.

## See Also

- `ficus squad-preset list` — View available squad presets
- `ficus agent-type list` — View available agent types
- `ficus agent-type get <id> --resolved` — Print an agent type's composed system prompt (its own prompt plus enabled includes, in order)
- `ficus shared-prompt list` / `ficus shared-prompt get <id>` — List or inspect shared prompts
- `ficus shared-prompt update <id> --file <path>` — Replace a shared prompt's content from a file
- `ficus shared-prompt disable <id>` / `ficus shared-prompt enable <id>` — Toggle a shared prompt's availability
