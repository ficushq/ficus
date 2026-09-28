---
name: agent-scopes
description: 'Explain and manage per-agent extra permission scopes via the Ficus CLI. Use when granting, auditing, or revoking narrowly-scoped permissions for a specific agent.'
---

# Agent Extra Scopes

## Overview

Agent extra scopes are additive permission grants for one specific agent. They
are used when an agent needs a narrowly-scoped capability that its agent type's
normal role does not include.

Extra scopes do **not** replace role permissions. Effective agent permissions are:

1. the role permissions from the agent's type, plus
2. any extra scopes granted directly to that agent.

Regular agent permissions are still gated by the squads the agent can access;
extra scopes do not make an agent globally omniscient.

## When to Use

Use agent extra scopes for temporary or exceptional access, for example:

- letting one trusted agent inspect a specific class of resource during an
  incident;
- testing a new permission before making it part of an agent type;
- granting an opt-in operational capability to a single standing agent.

Prefer changing the agent type or role defaults when **every** agent of that type
should always have the permission. Prefer a short-lived work stream with properly
staffed agents when the need is task-specific implementation work.

## Security Model and Guardrails

Managing extra scopes is intentionally privileged.

- Listing scopes requires `agents:scopes:read`.
- Granting or revoking scopes requires `agents:scopes:manage`.
- Scope management is admin-only by default; do not add it to ordinary operator
  roles casually.
- You can only grant a permission that you already hold.
- Grantable values must be known permissions from Ficus's permission catalog, or a
  known resource wildcard like `agents:*`.
- The global wildcard `*` is not grantable as an extra scope.
- Unknown resources/actions are rejected.
- Extra scopes do not apply to system-manager agents.

Treat every grant as a least-privilege exception. Grant the narrowest exact
permission possible, document why it is needed in your operator notes or the
relevant work stream, and revoke it when it is no longer needed.

## CLI Commands

### List an Agent's Extra Scopes

```bash
ficus agent scope list <agent-id>
```

This prints the additive permissions currently granted directly to that agent,
including creation timestamps.

### Grant an Extra Scope

```bash
ficus agent scope grant <agent-id> <permission>
```

Examples:

```bash
# Grant one exact permission
ficus agent scope grant 00000000-0000-0000-0000-000000000000 inbox:read

# Grant all known permissions under a resource namespace
ficus agent scope grant 00000000-0000-0000-0000-000000000000 agents:*
```

If the command fails, check the error before retrying:

- `permission is not grantable` means the permission is unknown, the resource
  wildcard is unknown, or you attempted to grant `*`.
- `Cannot grant a permission you do not hold` means your own identity lacks that
  permission.
- `Scope already granted to this agent` means the agent already has that exact
  extra scope.
- `Extra scopes do not apply to system-manager agents` means the target is a
  system-manager agent rather than a regular squad agent.

### Revoke an Extra Scope

```bash
ficus agent scope revoke <agent-id> <permission>
```

The revoke command also has an `rm` alias:

```bash
ficus agent scope rm <agent-id> <permission>
```

Revocation takes effect for subsequent permission checks. After changing scopes,
Ficus invalidates access caches so new authorization decisions use the updated
scope set.

## Recommended Workflow

1. Identify the exact missing permission from the failure or operation being
   attempted.
2. Confirm the target agent and its current grants:

   ```bash
   ficus agent get <agent-id>
   ficus agent scope list <agent-id>
   ```

3. Grant the narrowest permission that solves the problem:

   ```bash
   ficus agent scope grant <agent-id> <permission>
   ```

4. Ask the agent to retry the operation.
5. When the exceptional need is over, revoke the grant:

   ```bash
   ficus agent scope revoke <agent-id> <permission>
   ```

6. Re-list scopes to verify cleanup:

   ```bash
   ficus agent scope list <agent-id>
   ```

## Choosing Scope Values

Use exact permissions when possible:

```bash
ficus agent scope grant <agent-id> workstreams:read
ficus agent scope grant <agent-id> agents:update
```

Use resource wildcards only when the agent truly needs the full set of actions
for a known resource namespace:

```bash
ficus agent scope grant <agent-id> workstreams:*
```

Do not try to grant global admin:

```bash
# Rejected
ficus agent scope grant <agent-id> '*'
```

## Web UI

Agents with `agents:scopes:read` can see the **Extra Scopes** panel in an
agent's details. Agents with `agents:scopes:manage` can grant and revoke scopes
from that panel. The CLI commands above are the preferred audit-friendly path for
operational runbooks.
