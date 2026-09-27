# Server compatibility and capabilities

`GET /api/auth/status` includes a `server` object before sign-in. `GET /api/auth/introspect` includes the same object alongside identity, roles, and permissions. `ficus whoami` shows the release/API versions and revision in text output, and preserves the full object at `instance.server` in JSON output.

```json
{
  "product": "tau",
  "version": "0.2.0",
  "revision": null,
  "apiVersion": 1,
  "capabilities": {
    "workstreams.workflow-runs": 1,
    "workstreams.assigned-reviewers": 1,
    "workstreams.save-workflow": 1,
    "auth.signup-default-role": 1
  }
}
```

`version` comes from the Core package. `revision` is the deployed artifact or checkout commit from the existing build reporter; it is null when unavailable. A source checkout's revision is diagnostic and does not prove the process was rebuilt after a checkout change. Neither field should be used as a feature gate.

`apiVersion` is the major API contract. Additive fields and endpoints do not bump it; an incompatible change to baseline behavior needs an explicit compatibility decision and client support.

## Capability meanings

| Name                             | Contract 1                                                                                                                                                                                    |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workstreams.workflow-runs`      | Workflow run state, steps/attempts, handoffs, and human approval decisions on work streams.                                                                                                   |
| `workstreams.assigned-reviewers` | Read and update assigned human reviewers. An assigned-reviewer gate permits any reviewer with review permission when the list is empty.                                                       |
| `workstreams.save-workflow`      | Save a work stream's workflow as a reusable preset, subject to the existing create permissions.                                                                                               |
| `auth.signup-default-role`       | Read/update nullable `defaultSignupRoleId` in authentication settings. New email-verified self-registrations receive that role at instance scope; existing users and invites are not changed. |

The names advertise implemented API contracts, not granted permissions, configured integration accounts, subscription entitlements, or current runtime health. An advertised workflow capability does not mean a user can approve every work stream. Continue to evaluate permissions and resource state normally.

Clients should use capability names only when they have an actual alternate experience, such as hiding an unsupported assigned-reviewer editor while still displaying the work stream. A missing name is not advertised; an unknown name can be ignored. Only use contract versions that the client understands. Don't compare package versions or assume an unknown major API version is compatible.

The shared client's `AuthStatus.server` is optional so discovery works against servers predating this response. An absent object means compatibility information is unknown; it must not crash connection or silently imply all new features exist. Cache discovery per server origin, and refresh when connecting or reconnecting. This change exposes the contract through the shared auth client; it does not retrofit every mobile control with a compatibility fallback.

Durable chat queues are baseline behavior. Chat remains usable during maintenance, with accepted work queued for resumption. There is no durable-queue capability field or fallback that disables the composer.
