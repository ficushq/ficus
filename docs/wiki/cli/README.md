# Tau CLI Documentation

For configurable squads, lazy participants, parallel flows, scoped waits, and delivery policies, see [Workflows, flows, and squads](../workflows.md).

The `tau` CLI is the primary interface for interacting with the Tau API. It covers agent management, squads, work streams, scheduling, secrets, and more.

## Installation & Usage

`ficus.js` is a self-executable script (has a shebang line) — no wrapper script needed. It is installed on `PATH` in both the **core Docker image** and **sandbox pods**, so agents can use `ficus` directly inside their sandbox to interact with the API.

## Environment Variables

| Variable           | Description                                                                                       | Default                 |
| ------------------ | ------------------------------------------------------------------------------------------------- | ----------------------- |
| `FICUS_API_URL`    | URL of the Tau API server                                                                         | `http://localhost:3000` |
| `FICUS_TOKEN`      | Scoped agent token or other explicitly supplied token                                             | —                       |
| `FICUS_PASSWORD`   | Explicit human credential; legacy `/etc/tau/password` fallback applies only outside agent context | —                       |
| `FICUS_AUTH_STORE` | Override path for labeled CLI backends                                                            | `~/.tau/cli/auth.json`  |
| `FICUS_SQUAD_ID`   | Default squad context for squad-scoped commands                                                   | —                       |

Outside agent context, the CLI can use labeled backends saved by `tau auth login`, explicit environment credentials, and legacy `.env` or mounted-password fallbacks. See `tau auth status` and [Core authentication](../core-auth.md) for the current login model.

Inside a shell Tau built for an agent — one it gave a scoped token — the runtime sets `FICUS_AGENT_CONTEXT=1`
(plus `FICUS_AGENT_ID`, `FICUS_TOKEN`, `FICUS_API_URL` and a per-agent
`FICUS_AUTH_STORE`). There, resolution is env-only: the auth store, the `.env`
fallback and `/etc/tau/password` are never consulted and `--backend` is refused,
so no ambient operator login can be picked up by accident. On the host runtime
that closes the accident, not the deliberate case — see
[agent identity and its standing limits](../host-runtime.md#agent-identity). Run `tau whoami` to see
which instance a shell talks to and as whom.

## Global Options

```bash
tau --json     # Output in JSON format
tau --quiet    # Minimal output
tau --backend <label>  # Select a saved backend for this command (outside agent context)
```

## Command Groups

| Command                   | Alias   | Description                           |
| ------------------------- | ------- | ------------------------------------- |
| `tau agent-type`          | `at`    | Manage agent types                    |
| `tau agent`               |         | Manage agents                         |
| `tau worker`              |         | Manage workers                        |
| `tau chat`                |         | Chat with your User Assistant         |
| `tau image`               |         | Manage images                         |
| `tau action`              |         | Manage actions                        |
| `tau webhook`             |         | Manage webhooks                       |
| `tau squad`               |         | Manage squads                         |
| `tau slot`                |         | Coordinate squad capacity slots       |
| `tau squad-preset`        | `st`    | Manage squad presets                  |
| `tau workstream`          | `ws`    | Manage work streams                   |
| `tau schedule`            |         | Manage schedules                      |
| `tau inbox`               |         | Manage inbox                          |
| `tau memory`              |         | Manage agent memory                   |
| `tau discord`             |         | Discord integration                   |
| `tau secret`              |         | Manage secrets                        |
| `tau squad-env`           |         | Manage squad environment variables    |
| `tau channel`             | `ch`    | Manage channel instances              |
| `tau notification-config` | `notif` | Manage notification config            |
| `tau provider-auth`       | `pa`    | Manage AI provider credentials        |
| `tau system`              |         | System management                     |
| `tau whoami`              |         | Show this shell's instance + identity |

Other current command groups include:

| Command                                | Description                                                                      |
| -------------------------------------- | -------------------------------------------------------------------------------- |
| `tau auth`                             | Log in, switch backends, inspect identity, and log out                           |
| `tau search <query>`                   | Search squads, work streams, consultant chats, and saved Assistant conversations |
| `tau integration`                      | Connect, inspect, and assign external integrations                               |
| `tau workflow`                         | Manage presets, preview flows, and advance or finish flow runs                   |
| `tau agent-question` (`aq`)            | Manage asynchronous agent questions                                              |
| `tau deploy`                           | Manage local app runs and external deployment records                            |
| `tau skill` (`skills`)                 | Manage bundled and dynamic agent skills                                          |
| `tau shared-prompt` (`shared-prompts`) | Manage shared prompts included by agent types                                    |
| `tau remote-hosts`                     | Manage team-owned SSH hosts                                                      |
| `tau amtp` / `tau remote`              | Manage federation and agent federation identity                                  |
| `tau machines`                         | Manage VM sandbox machines                                                       |
| `tau monitor`                          | Read or cancel agent-owned monitors                                              |
| `tau server`                           | Manage the instance installed on this machine                                    |
| `tau install` / `tau update`           | Install the CLI or update an instance                                            |
| `tau admin`                            | Operator maintenance actions                                                     |

Run `tau --help` and `tau <command> --help` for the complete current options.

## Detailed Documentation

| Document                                          | Description                                          |
| ------------------------------------------------- | ---------------------------------------------------- |
| [Squad System Overview](squad-system-overview.md) | High-level overview of the squad system architecture |
| [Squad Commands](squad-commands.md)               | Reference for common `tau squad` commands            |
| [Work Stream Commands](workstream-commands.md)    | Complete reference for `tau workstream` commands     |

## Quick Reference

### Squad Commands

```bash
tau squad list              # List all squads
tau squad create <name>     # Create a new squad
tau squad get <id>          # Get squad details
tau squad update <id>       # Update a squad
tau squad delete <id>       # Archive a squad, preserving history
tau squad agents <id>       # List agents in squad
tau workstream list --squad <id>  # List work streams for a squad
tau squad spawn <type> <id> # Spawn agent in squad
tau squad link <a> <b>      # Link two squads
```

### Slot Coordination Commands

Pool-scoped commands accept `--squad <id>` and otherwise use `FICUS_SQUAD_ID`.
Claim and waiter ids are globally unique, so the commands that address one take
the id alone: the server resolves its pool and squad, and checks your authority
against that squad.

```bash
tau slot list [key] [--squad <id>]
tau slot history <key> [--limit <1..100>] [--cursor <opaque>] [--squad <id>]
tau slot register <key> [--capacity <n>] [--timeout <duration>] [--squad <id>]
tau slot update <key> [--capacity <n>] [--timeout <duration>] [--squad <id>]
tau slot unregister <key> [--squad <id>]
tau slot claim <key> [--no-subscribe] [--squad <id>]
tau slot subscribe <key> [--squad <id>]
tau slot renew <claim-id>
tau slot release <claim-id>
tau slot unsubscribe <waiter-id>
```

`tau slot claim` joins the FIFO queue when no capacity is free, returning
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

Pool capacity is bounded from 1 through 1000 units. Claims expire automatically but expiry does not stop external work. When a claim times out without being released or renewed, Tau sends its owning agent one steering inbox reminder to stop the heavy processes, containers and test databases it started under the claim and to claim again before resuming heavy work. Release claims immediately when protected work finishes. Slot commands use exit code 0 for every successfully retrieved authoritative outcome, including `unavailable`, `queued`, `expired`, and `already_released`; automation must branch on the JSON `outcome` rather than treating admission state as a transport error. Invalid input, authorization failures, and API failures exit nonzero.

`tau slot list` prints each pool with the caller's own recovery state — a held claim with its expiry and release/renew commands, or a queued waiter with its queue time and unsubscribe command — so the identifiers needed for release, renew, and unsubscribe are directly copyable. Foreign holders stay redacted to short IDs; pass `--json` for the untouched server projection. Slot pools of an archived squad answer `410 Squad is archived`.

Ordinary slot list/detail responses omit terminal history, and acquisition JSON contains only the outcome, message, relevant claim or waiter identity, and a bounded five-field pool snapshot (`key`, `capacity`, `activeCount`, `availableCount`, and `queuedCount`). Use `tau slot history` to read terminal claims and waiters explicitly. History is paginated by the server (50 records by default, 100 maximum); use the returned opaque cursor to continue. Ordinary agents see only their own terminal records, while callers with `slots:write` see pool-wide diagnostics.

### Work Stream Commands

Prefer a saved workflow or explicit flow for new work:

```bash
tau workflow list
tau workstream create "Implement account search" --squad <id> --workflow engineering
tau workstream create "Summarize meeting notes" --squad <id> --workflow solo
```

The selected style defines participation and delivery. Participants are created lazily as their steps are reached. Every new stream uses a flow. Omit the source to use the squad default; manual staffing and completion flags are no longer accepted at creation. See [Workflows](../workflows.md) before combining creation options.

```bash
tau ws list                 # List work streams
tau ws create <title>       # Create work stream
tau ws get <id>             # Get work stream details
tau ws update <id>          # Update work stream
tau ws request-input <id> -m "<msg>"   # Open a manual wait (needs input/action)
tau ws unblock <id> -m "<note>"        # Resolve the input request
tau ws request-review <id> -m "<msg>"  # Open the review wait (--no-complete = checkpoint gate)
tau ws approve <id> [-m "<note>"]      # Approve review (completes the stream by default)
tau ws send-back <id> --note "<msg>"   # Send review back with feedback
tau ws handoff <id> --to <agent>       # Reassign to another agent
tau ws done <id>            # Mark as complete (rejected while waits are open)
tau ws reopen <id>          # Reopen a done/canceled stream
```

### Schedule Commands

```bash
tau schedule list           # List schedules
tau schedule create         # Create a schedule (supports workStream title/desc on spawn_agent action)
tau schedule update <id>    # Update a schedule
tau schedule delete <id>    # Delete a schedule
tau schedule trigger <id>   # Manually trigger a schedule
tau schedule enable <id>    # Enable a schedule
tau schedule disable <id>   # Disable a schedule
tau schedule show <id>      # Show schedule details
```

Schedule work using a preset or ephemeral flow. Omit the source to inherit the squad default at each run:

```bash
tau schedule create --squad <id> --name "Daily health" --interval 24h \
  --action create_work_stream --title "Check system health" --workflow solo

tau schedule create --squad <id> --name "Daily audit" --interval 24h \
  --action create_work_stream --title "Daily audit" --flow-content '{"kind":"preset","id":"solo"}'

tau schedule update <id> --workflow with-review
```

The flow owns participation and delivery policy, including `pr-merge`, `pr-auto-merge`, `review-approval`, or policy-gated `direct-merge`. `spawn_agent` schedules are only for standalone agents. To migrate a stored schedule with an agent list or completion flag, select a workflow; old `spawn_agent.workStream` schedules must change to `create_work_stream`.

Schedule list/show output separates configured Enabled state from execution Health. `show` includes attempts, failure counters, recovery timestamps, and the bounded safe error/automatic-disable reason. Temporary schedules can use `--expires-at <ISO-datetime>`; update with `--clear-expires-at` to restore indefinite operation.

### Secret Commands

```bash
tau secret list             # List all secrets (names only, no values)
tau secret get <key>        # Get a secret value
tau secret set <key> <val>  # Set a secret value
tau secret delete <key>     # Delete a secret
```

### Identity

```bash
tau whoami                  # Which instance this CLI talks to, as whom, and where that came from
tau whoami --json           # Same, as JSON
```

### Squad Environment Commands

Squad env content may not assign the keys tau injects to give an agent its
identity (`FICUS_TOKEN`, `FICUS_API_URL`, `FICUS_PASSWORD`, `FICUS_AUTH_STORE`,
`FICUS_AGENT_CONTEXT`, `FICUS_AGENT_ID`, `FICUS_IDENTITY_*`) — such a write is
rejected with a 400 naming the key and why. `PATH` may be extended as usual; on
the host runtime tau re-prepends its own shim directory afterwards, so squad
PATH additions apply but cannot displace `tau`.

```bash
tau squad-env get <squadId>                # Get .tau/.env content for a squad
tau squad-env set <squadId> <content>      # Set .tau/.env content (use quotes for multi-line)
tau squad-env set-file <squadId> <path>    # Set .tau/.env content from a file
tau squad-env secrets <squadId>            # List per-squad/global secret exposure status
tau squad-env expose-secrets <squadId> KEY # Expose Secret Store keys to one squad
tau squad-env global-secrets               # List globally exposed Secret Store keys
tau squad-env expose-global KEY            # Expose Secret Store keys to all squads
tau squad-env unexpose-global KEY          # Remove global exposure
```

### Channel Instance Commands

```bash
tau channel list            # List all channel instances
tau channel get <id>        # Get channel instance details
tau channel create          # Create a channel instance
tau channel update <id>     # Update a channel instance
tau channel delete <id>     # Delete a channel instance
tau channel template-diff <id>  # Show diff between config and YAML template
tau channel revert <id>     # Revert to YAML template
tau channel disable <id>    # Disable a channel instance
tau channel enable <id>     # Enable a channel instance
tau channel export <id>     # Export channel instance as YAML
```

### Notification Config Commands

```bash
tau notif get               # Get current notification config
tau notif set               # Update config from JSON file
tau notif template-diff     # Show diff between config and YAML template
tau notif revert            # Revert to YAML template
tau notif disable           # Disable notification config
tau notif enable            # Enable notification config
tau notif export            # Export config as YAML
```

### Provider Auth Commands

```bash
tau pa list                 # List all configured providers
tau pa get <provider>       # Check auth status for a provider
tau pa set <provider> <key> # Set an API key for a provider
tau pa delete <provider>    # Remove auth for a provider
tau pa oauth-providers      # List available OAuth providers
```

### System Commands

```bash
tau system restart          # Restart the server process (K8s auto-restarts the pod)
tau system logs             # Stream Tau system logs (API and worker)
tau system logs -c api -t 50 --no-follow
```

## Sandbox Usage

Tau injects a scoped `FICUS_TOKEN`, the instance `FICUS_API_URL`, and `FICUS_AGENT_CONTEXT=1` into agent shells. The CLI authenticates as that agent and resolves credentials only from the injected environment. It does not read the operator’s saved backend, `.env` password, or `/etc/tau/password` in agent context. The mounted-password fallback remains a legacy option for non-agent CLI use.

## See Also

- `tau squad-preset list` — View available squad presets
- `tau agent-type list` — View available agent types
- `tau agent-type get <id> --resolved` — Print an agent type's composed system prompt (its own prompt plus enabled includes, in order)
- `tau shared-prompt list` / `tau shared-prompt get <id>` — List or inspect shared prompts
- `tau shared-prompt update <id> --file <path>` — Replace a shared prompt's content from a file
- `tau shared-prompt disable <id>` / `tau shared-prompt enable <id>` — Toggle a shared prompt's availability
