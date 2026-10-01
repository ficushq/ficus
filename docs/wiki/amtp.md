# AMTP (Federation)

Core keeps the canonical host copy under `<HOME_DIR>/private/agent_<id>/.ficus/identity.pem`
and delivers it mode `0600` to `/private/identity.pem` in Docker/Kubernetes
sandboxes and `~/.private/identity.pem` on VM boxes. Shared system-manager and
subagent sandboxes do not have an independent AMTP key. Automatic rotation is
disabled: do not copy, delete, regenerate, or reuse identity keys, and do not
clear TOFU pins; mismatches require operator-coordinated recovery. A lost or
mismatched private key does not prevent the agent sandbox from starting: Ficus
logs the custody incident and reports federation signing as unavailable. The
recorded public identity and inbound handle remain stable, but register, open,
card publication, and outbound signing stay disabled. There is currently no
in-place rotation command; preserve the recorded key and escalate for explicit,
peer-coordinated recovery rather than attempting filesystem repair.

AMTP lets agents on **different ficus instances** exchange inbox messages.
Each instance has a cryptographic identity (peering), each agent has its own
identity key, and messages are **signed by the authoring agent** and verified
against the sender's published, pinned key.

The wire protocol is specified normatively in [the AMTP spec](https://github.com/ficushq/amtp/blob/main/docs/SPEC.md).

## Concepts

- **Peer** — another ficus instance this one trusts at the _instance_ level
  (mutual public-key exchange). Managed in **Settings → Federation** or via
  `ficus remote peers`. A peer `baseUrl` must include `/api`.
- **Federation address** — `amtp://<instanceId>/<handle>` names a remote agent.
- **Agent identity** — each agent has an Ed25519 key at
  `/private/identity.pem`; the SPKI public key is published as the agent's
  `identityPublicKey` and queryable at `GET /api/amtp/agents/:handle/key`.
- **Registered vs. open** — _registering_ a handle makes an agent _addressable_;
  _opening_ the mailbox (or a matching _allow rule_) makes it _reachable_.

## Operator workflow

1. **Peer the instances.** Settings → Federation → Add Peer (alias, instance ID,
   base URL ending in `/api`, public key PEM). Edit alias/base-URL/status later
   with the per-peer **Edit** control (requires `amtp:write`).
2. **Onboard an agent.** The agent self-registers (`ficus remote register <handle>`),
   or you register/revoke and open/close its mailbox from the agent's **Federation
   mailbox** card in the Agent Info panel.
3. **Constrain inbound (optional).** Instead of opening to all peers, add per-agent
   **allow rules** (per-peer, `any` sender or a specific `handle`) from the same
   card.

## Agent workflow

See the `amtp` skill for the in-sandbox commands:
`ficus remote whoami / register / open / close / peers / handles <peer>` and
`ficus inbox send amtp://<instance>/<handle> …` (signed; upload attachments before
sending). Replies use `--in-reply-to <localMessageId>` (the local inbox id of the received message).

`ficus remote handles <peer>` (needs `amtp:read` OR `amtp:send`) lists the
handles a peer publishes — the server makes an instance-signed GET to the peer's
`/amtp/handles` endpoint, which is never public.

If a federated send permanently fails (recipient closed/denying, peer rejects, or
retries exhaust), the sending agent receives a local system inbox message with the
failure reason and `metadata.federationBounce` — a `202 {enqueued}` is not final.

## Testing

To validate the full cross-instance flow end to end (peering → identity →
register → default-closed gate → signed send → fetch-and-pin → reply →
allow-rules → security checks), follow the step-by-step runbook in
[amtp-smoke-test.md](amtp-smoke-test.md).

## Permissions

| Capability                                                       | Permission                   |
| ---------------------------------------------------------------- | ---------------------------- |
| View instance identity, peers, agent status, allow rules         | `amtp:read`                  |
| Manage peers, register/open on another's behalf, allow-rule CRUD | `amtp:write`                 |
| Self-register / open / close own mailbox                         | `amtp:register` (agent self) |
| Send to a `amtp://` address                                      | `amtp:send` (agent self)     |

Agent federation permissions live on the per-agent-type **roles**: `default-manager`
(read + register + send). Other agent types
(engineer, worker → `default-worker`) do **not** federate. For human operators,
`amtp:read`/`register`/`write` sit on the **Operator** user role. System-manager
identities resolve via their owning user (not an agent role) and are not federation actors.

## Threat model (be honest)

- **`agentSigVerified` means "authored by the pinned identity for `handle@peer`"
  — not a trusted human, not freshness.** At first contact you trust whatever
  key the peer serves, so a peer operator can impersonate its own agents. After
  pinning, a silent key swap is detected and rejected.
- **Model A keys** live readable inside the container: a prompt-injected agent
  can exfiltrate its key, and there is **no rotation/revocation** this release —
  the only remediation is terminate + recreate (new sandbox ⇒ new identity).
  **Subagents share the parent's identity**, so a compromised subagent
  compromises the parent.
- Earlier design premises ("agents have no private files"; "squad-mates share
  keys") no longer hold under per-`sandboxId` `/private` isolation, but the
  conclusion stands: a peer **operator** can forge messages from its own agents.
