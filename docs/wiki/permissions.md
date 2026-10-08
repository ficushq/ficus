# Permission catalog

Ficus uses the shared catalog in
[`packages/shared/src/permissions.ts`](../../packages/shared/src/permissions.ts).
Every named permission has a description in
[`packages/shared/src/permission-catalog.ts`](../../packages/shared/src/permission-catalog.ts).
The same searchable picker appears in **Administration → System Tokens**, role
editing, and an agent’s **Extra Scopes** panel.

Expand a resource group to see its permissions and descriptions. Search matches
both names and descriptions; **Show selected only** lets you review the grants
before saving. A write permission does not automatically include read access.
Select both when an automation needs both.

System tokens are user-less automation credentials. Their scopes apply globally,
while endpoint-specific ownership and resource checks still apply. A permission
alone does not turn a token into a user or an agent. The token value is revealed
only once, after creation.

## Human-only squad controls

Some squad settings check `squads:update` **and** require a literal, enabled human
user. Agent tokens are refused even when the agent is acting for a user or has
`squads:update` through its role or extra scopes. These settings are GitHub
trusted authors, GitHub feedback moderation (allow, deny, allow and trust) and the
GitHub author filter. Role and user changes that would change who is dynamically
trusted need the same human authority. See
[Author trust and held feedback](github-integrations.md#author-trust-and-held-feedback).

Three user-management actions now also require a literal human, because each
hands out or redirects a way to sign in as a person. A person's session could
then moderate GitHub feedback or change trust, which agents must not do.
Agents and system tokens are refused even with `users:create` or `users:update`:

- Re-sending an invite or creating an invite link (`POST /users/:id/invite`), for
  any user.
- Changing a user's email address (`PATCH /users/:id` with a new `email`), for any
  user. Display-name changes are unaffected.
- Receiving the invite code or link when creating a user (`POST /users`) on an
  instance with no mail configured. Automation can still create the user; the
  response reports the invite as undelivered and a person sends it later.

A human making these changes for a user who is dynamically trusted in a squad
also needs `squads:update` in that squad. Each attempt is recorded in the
integration audit log.

## Exact grants and wildcards

Selecting permissions saves their exact names. Selecting every permission in a
group does **not** create a wildcard. This avoids automatically granting newly
introduced actions when Ficus is updated.

Existing wildcard grants remain visible and unchanged until removed. A resource
wildcard such as `workstreams:*` includes all current and future permissions for
that resource. The global `*` grants all permissions and is not offered by the
normal picker. System tokens retain an advanced custom-scope input for explicit
wildcards and dynamically qualified grants.

Some permissions can be narrowed with a qualifier:

- `integrations:read:github` or `integrations:write:github` limits the corresponding
  integration settings/account access to GitHub. Squad connection management and
  execution have their own `integrations:read`, `integrations:write`, and
  `integrations:use` checks.
- `secrets:read:integration` limits secret access to the configured integration
  group. Secret group membership is defined in `config/secrets/groups.yaml`.

A bare grant such as `secrets:read` also includes its qualified variants. The
picker marks those rows as included by the broader grant. Remove the broader
grant before choosing narrower access. Protected platform credentials remain
protected even with secret permissions.

## Retired names

Unused `squads:write`, `schedules:write`, `ai:read`, `ai:write`, `actions:write`,
`channels:respond`, and `system:worker-status` entries have been removed from the
active catalog and bundled configuration. These names did not gate current API
operations. They are not aliases for the current permissions.

Existing custom grants are preserved and shown separately so an administrator
can review and remove them. They are never automatically translated into broader
permissions. Use the current catalog descriptions to choose the actions needed.
For example, squad editing uses `squads:update`; worker status uses `squads:read`.
Historical design documents may still mention the retired names.

## Keeping the catalog current

Add new named permissions to `Permissions` and describe the actual backend action
in `PERMISSION_DESCRIPTIONS`. Typechecking requires a description for every
catalog entry. The shared package tests inspect literal backend authorization
calls and bundled role grants to catch missing catalog entries. Dynamic
integration and secret qualifiers are checked against their cataloged base
permission.
