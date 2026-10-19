# Decision evaluation access

Decision evaluations can use a running instance without receiving its provider
keys. They send labelled evaluation inputs to that instance; use only data that
may be sent to its configured providers. The repository's evaluation and snapshot
requirements are in [AGENTS.md](../../AGENTS.md#decision-features-need-evals).

## Worker invocation

With the worker's existing injected `FICUS_API_URL` and `FICUS_TOKEN`:

```bash
bun run decisions:eval tool-firewall --from worker --repeat 2 --record --max-cost 1
```

Replace `tool-firewall` with a name from `bun run decisions:eval --list`.
`--provider <id|kind,...>` limits the enabled providers to ask. No provider key,
human login, password file or saved backend is read in worker mode. Missing URL
or token, denied access, an old server without the endpoint, or an empty provider
list fails rather than falling back to another host, database or provider.
Redirects are refused. API URLs must be HTTP(S) without embedded credentials,
query strings or fragments; HTTPS is recommended outside loopback.

Provider source selection is explicit:

- `--from worker`: injected API URL and token, even if a saved login exists.
- `--from backend:<label>`: that operator's saved CLI backend, not ambient API
  credentials. Honors `FICUS_AUTH_STORE`; the legacy
  `FICUS_DEV_AUTH_STORE_PATH` remains supported when it is absent. Backend mode is
  refused in `FICUS_AGENT_CONTEXT=1` and `FICUS_WEBHOOK_CONTEXT=1`: those contexts
  must use their injected identity, never a human login.
- `--from env`: existing `FICUS_EVAL_<KIND>_*` provider configuration.
- `--from local`: existing root `.env` database and server-side secret store.

Without `--from`, injected agent/webhook contexts default to `worker`; other
shells retain `local`. Explicit sources never fall back to one another. Local/env
modes still need direct provider access and are not the least-privilege worker
path. Candidate-correction inbox operations remain local administrative tasks.

## Minimal operator setup and revocation

Deploy a version that contains the evaluation endpoint through the normal,
separately authorized rollout process. An authorized operator must already have
configured and enabled suitable decision providers. This change does not deploy
a server, enable providers or grant any live permissions automatically.

For a live, userless squad worker, an authorized operator can grant **only**
`decisions:evaluate` using **Agent → Extra Scopes**, or:

```bash
ficus agent grant <worker-id> decisions:evaluate
# After the evaluation run:
ficus agent revoke <worker-id> decisions:evaluate
```

The grant/revoke APIs require `agents:scopes:manage`; granting also requires
the permission being granted. Do not grant `provider-auth:write`,
`secrets:read`, a wildcard, a provider key or a personal token to run evaluations.
Use an individual worker grant rather than editing a default role or agent type.
Per-agent scopes follow the existing root-agent/descendant authority rules;
revoking the root grant removes that inherited permission too. An agent backed
by a human owner instead resolves through that owner's roles; extra scopes do
not augment that path. Squad-less userless agents fail closed.

For a human evaluator, use an explicit system-scoped role containing
`decisions:evaluate`; a squad-only/default user role is not enough for this
instance-level endpoint. Existing operators with `provider-auth:write` keep
Settings' Try and may also use the evaluation endpoints. System tokens use
only their assigned scopes, as usual; creating one is unnecessary for workers.
No default role or token receives the new capability.

## API boundary

Both `GET /api/decisions/evaluate` and `POST /api/decisions/evaluate` check
`decisions:evaluate` (or existing `provider-auth:write`) on every request, using
existing unscoped RBAC semantics. Agent grants are checked against the live
agent's own squad authority. There is no caller-selected squad or attribution.

GET returns only enabled providers' IDs, labels, kinds, models, enabled status
and effective input prices. It does not return URLs, account IDs, key-presence
flags, secrets, routing, feature switches, spend or capture settings. POST requires
a known `purpose`, an explicit enabled `providerId` and a valid decision request.
Unknown and disabled providers are refused identically. Additional fields
(including URL/key/source/squad overrides) are rejected. It never changes routing
or runs a provider chain on failure. Evaluation-only access does not authorize
Settings' Try, provider management/detection, feature/capture changes, secret
reads or permission grants. Provider failure details are deliberately generic,
not upstream bodies, credential-bearing URLs or account IDs.

## Cost, limits and operational caveats

Successful remote calls use the normal decision cost calculation and inference
ledger under `decision:<purpose>`, tagged `kind: eval`. User/agent/squad fields
come from the authenticated identity, not the request. The ledger source also
records the authenticated actor (including a system token's ID, never its value).
The decision log records answers or sanitized failures, the input hash and the
same source. Failed calls without reported usage do not create a ledger charge;
the upstream provider may still charge for work it performed. Usage writes are
asynchronous and retain the existing best-effort logging behavior.

The evaluation endpoint enforces:

- **60 admitted inference calls per caller per fixed 60-second window**, including
  failed calls; at most **4 concurrent calls per caller**. Denials return 429
  with `Retry-After: 60`, without invoking a provider. Slots release on completion,
  provider error, timeout and client cancellation. The bounded caller table fails
  closed when full (10,000 active/recent principals).
- **64 KiB UTF-8 JSON text** for state and questions, **12 MiB total request body**,
  plus the existing question, image type/count/size and model image-support
  checks. Oversize text/body returns 413 before inference.
- The lesser of the configured decision-routing timeout and **30 seconds**, plus
  client cancellation. Provider-side rate/credit restrictions still apply.

These caps are **per authenticated principal, per API process**, not a durable or
distributed quota. They reset on restart; multiple API replicas and multiple
principals multiply capacity. GET metadata requests are permission-checked but
are not inference calls. There is **no hard dollar spend quota** here. The runner's
`--max-cost` (default $1) is a soft stop based on returned/estimated costs, can
overshoot with in-flight calls, and cannot constrain an arbitrary API client.
It is not the authorization boundary. Evaluate whether these limits are adequate
for the deployed topology before granting access; use provider-side budgets and
operator monitoring where needed, and revoke the temporary grant afterward.
