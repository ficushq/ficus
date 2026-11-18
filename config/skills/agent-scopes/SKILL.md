---
name: agent-scopes
description: 'Explain and manage per-agent extra permission scopes via the Ficus CLI. Use when granting, auditing, or revoking narrowly-scoped permissions for a specific agent.'
---

# Agent Extra Scopes

An extra scope is a permission granted directly to one agent, on top of its agent
type's role. It is still limited to the squads that agent can access. Use one for a
temporary or exceptional need; when every agent of a type needs the permission,
change the agent type instead.

## Grant rules

- Listing needs `agents:scopes:read`; granting and revoking need
  `agents:scopes:manage` (admin-only by default).
- You can grant only a permission you hold yourself.
- A grant is an exact permission from Ficus's catalog (`workstreams:read`) or a
  known resource wildcard (`workstreams:*`). The global `*` is never grantable.
- Extra scopes do not apply to system-manager agents.
- Grant the narrowest permission that solves the problem, record why in the
  relevant work stream, and revoke it when the need ends. A revoke applies to the
  next permission check.

## Commands

```bash
ficus agent get <agent-id>
ficus agent scope list <agent-id>
ficus agent scope grant <agent-id> <permission>
ficus agent scope revoke <agent-id> <permission>   # alias: rm
```

## Errors

| Error                                                | Meaning                                         |
| ---------------------------------------------------- | ----------------------------------------------- |
| `permission is not grantable`                        | Unknown permission or resource wildcard, or `*` |
| `Cannot grant a permission you do not hold`          | Your own identity lacks it                      |
| `Scope already granted to this agent`                | Nothing to do                                   |
| `Extra scopes do not apply to system-manager agents` | The target is a system manager                  |

The agent's details page shows the same grants in its **Extra Scopes** panel.
