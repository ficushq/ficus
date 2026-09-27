# AMTP Smoke Test (production)

End-to-end manual test of AMTP (federation) Slice 5 across **two real ficus instances**.
You will peer the instances, give an agent an identity + handle, prove the
default-closed gate, send a signed `amtp://` message, verify authorship pinning,
reply, and exercise the allow-rule and security paths.

Budget ~20 minutes for the happy path.

## Prerequisites

- **Two deployed ficus instances** with this slice shipped — call them **A** and
  **B**. They must be able to reach each other's `…/api` over HTTPS (the receiver
  fetches the sender's published key, and each delivers to the other's inbox).
- **Operator access** (a login with `amtp:write`/`read`) on both instances —
  for the web UI and, optionally, an operator-authenticated CLI.
- **One agent on each instance** whose agent-type can federate — **manager** or
  **consultant** (federation lives on the `default-manager` roles;
  engineer/worker and system-managers cannot federate). We use **`alice` on A** (the
  sender) and **`bob` on B** (the recipient).

### Two actors, two ways to run commands

| Actor        | How it acts                                                                                                                                                                                                                                                      |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Operator** | Web UI (**Settings → Federation**, and each agent's **Federation mailbox** card in the Agent Info panel) or an operator-authenticated `ficus` CLI.                                                                                                               |
| **Agent**    | Runs `ficus …` **inside its own sandbox**. Drive it by asking the agent in chat, e.g. _"Run `ficus remote register alice` and paste the output."_ The CLI is auto-authenticated in-sandbox via `FICUS_TOKEN` and signs with the agent's `/private/identity.pem`. |

> **Sending is always agent-driven.** A `amtp://` message is signed with the
> agent's private key, so only the agent (in its sandbox) can send. Registering
> and opening can be done by the agent _or_ the operator; allow-rules are
> operator-only.

---

## Step 1 — Exchange instance identities

Each instance has a cryptographic identity (`instanceId` + public key PEM).

- **Operator on A:** Settings → Federation shows A's instance ID + public key.
  (CLI equivalent: `ficus federation identity` → `{ instanceId, publicKeyPem }`.)
- **Operator on B:** same, for B.

Copy each instance's `instanceId` and public-key PEM; you'll paste them into the
other instance in the next step.

✅ **Expect:** a stable `instanceId` (key fingerprint) and a PEM public key on each.

## Step 2 — Peer the instances (both directions)

Federation needs **mutual** peering: A must know B to deliver to it, and B must
know A to verify A's instance signature and fetch A's agent keys.

- **Operator on A:** Settings → Federation → **Add Peer** — alias `B`, B's
  instance ID, base URL **ending in `/api`** (e.g. `https://b.example.com/api`),
  B's public-key PEM.
- **Operator on B:** Add Peer for **A** the same way.

CLI equivalent (operator-authenticated):

```bash
ficus federation peer add --alias B \
  --instance-id <B-instanceId> \
  --base-url https://b.example.com/api \
  --public-key <B-public-key.pem-or-literal>
```

✅ **Expect:** each instance lists the other under Settings → Federation (or
`ficus federation peer list`), status **active**. A wrong/missing peer key later
shows up as a `401` instance-signature rejection on delivery.

## Step 3 — Confirm each agent has an identity

Agent identities are generated automatically when the sandbox is provisioned.

- **Ask `alice` (A) in chat:** _"Run `ficus remote whoami`."_

✅ **Expect:** live status with `registered: false` and `federationReady: false`
(the handle has not been claimed yet), plus server
`signingIdentity.status: "ready"` and local
`localSigningIdentity.status: "ready"`. The matching ready states confirm that
Core's recorded public identity and the delivered `/private/identity.pem` agree.

> If either signing identity is unavailable or unsupported, follow its message.
> Do not generate, copy, delete, or replace keys; retry only when the message says
> provisioning is still pending, otherwise contact an operator.

## Step 4 — Register handles (addressable, but NOT yet reachable)

- **Ask `bob` (B) in chat:** _"Run `ficus remote register bob`."_
- **Ask `alice` (A) in chat:** _"Run `ficus remote register alice`."_

✅ **Expect:** each prints `Registered as amtp://<thatInstanceId>/<handle>` plus
`{ handle, address, identityPublicKey }`. Re-running with the same handle is
idempotent; a handle already taken on that instance returns `409`.

Operator alternative: the agent's **Federation mailbox** card → enter a handle →
**Register**.

## Step 5 — Prove the default-closed gate

Registration alone must **not** make `bob` reachable. Test it before opening.

- **Ask `alice` (A) in chat:** _"Run `ficus inbox send amtp://<B-instanceId>/bob "ping before open"`."_

✅ **Expect:** the send is accepted locally (`{ enqueued: true, outboxId }`,
HTTP 202) — but **`bob` receives nothing**. Delivery is rejected at B's receiver
(`403`, default-deny) and the message lands as a terminal failure in A's outbox.
Confirm `bob`'s inbox/chat shows **no** new remote message.

This is the core safety property: a registered handle is addressable, not an open
door.

## Step 6 — Open the mailbox and send for real

- **Ask `bob` (B) in chat:** _"Run `ficus remote open`."_ (or Operator: the mailbox
  card → **Open**). ✅ `Mailbox open`; `ficus remote whoami` now shows
  `inboundOpen: true`, `allowsInbound: true`.
- **Ask `alice` (A) in chat:** _"Run `ficus inbox send amtp://<B-instanceId>/bob --subject "smoke test" "hello from alice"`."_

✅ **Expect on B:** `bob` is **woken with a new inbox message** within a few
seconds — sender shown as the remote address `amtp://<A>/alice`, subject
`smoke test`, body `hello from alice`. This is the full happy path:
sign → deliver → instance-verify → fetch-and-pin alice's key → authorship-verify
→ deliver → wake bob.

### Verify authorship pinning (first contact)

On this first message B fetched alice's published key from A and pinned it, then
verified the signature. The message metadata records
`agentSigVerified: true` (authored by the pinned identity for `alice@A`). If your
build surfaces a verified/remote badge on the message, confirm it; otherwise this
is recorded on the inbox row's `metadata.remote`.

## Step 7 — Reply across instances

- **Ask `bob` (B) in chat:** _"Reply to that message: `ficus inbox send amtp://<A-instanceId>/alice --in-reply-to <localInboxMessageId> "got it"`."_ — use the **local inbox id of the received message**.

> For the reply to be delivered, `alice`'s mailbox on A must accept inbound from
> B — open it (`ficus remote open` as alice) or add an allow-rule (Step 8). The
> threading reply field rides the wire automatically.

✅ **Expect:** `alice` (A) is woken with `got it` from `amtp://<B>/bob`.

## Step 8 — Constrained inbound via allow-rules (operator)

Instead of opening to every known peer, scope inbound to specific senders.

- **Operator on B:** `bob`'s **Federation mailbox** card → **Close** the mailbox,
  then add an **allow rule**: peer **A**, principal **handle** `alice`.
- **Ask `alice` (A) to send again** → ✅ delivered (rule matches).
- If you have a second registered agent on A (e.g. `carol`), have it send to
  `bob` → ✅ **rejected** (no rule for `carol`), proving rules are per-sender.

Allow-rules are **per recipient agent** — a rule on `bob` never affects another
agent. Use principal `any` to accept all senders from a given peer.

## Step 9 — Web UI verification

- **Settings → Federation** (operator): both peers listed; **Edit** changes
  alias/base-URL/status; **Remove** asks for confirmation.
- **Agent Info → Federation mailbox** (operator, on `bob`): shows the handle,
  `Inbound open`/`closed`, an **Allows inbound** badge, and the allow-rules
  editor (add/delete). Operator controls require `amtp:write`; a viewer
  without `amtp:read` simply sees no card (no 403 spam).

## Step 10 — Security checks (optional, recommended)

- **Replay dedup.** Re-deliveries of the same envelope id are idempotent — a peer
  can't double-deliver. (Observed implicitly; the receiver de-dupes on
  `(peerInstanceId, envelopeId)`.)
- **No rotation / pin-mismatch.** Terminate and recreate `alice`'s sandbox → it
  gets a **new** identity key. Re-register the same handle and send to `bob`
  again → ✅ **rejected** with a key mismatch, because B still has the _old_ key
  pinned (there is no key rotation this release). This is expected; remediation
  is out of band. _(Skip unless you want to verify the no-rotation contract — it
  leaves `bob` unable to receive from `alice` until B's pin is cleared in the DB.)_
- **Fail-closed on key-endpoint outage.** If B cannot fetch a sender's published
  key on first contact (A's key endpoint unreachable), B returns a **retryable
  502** and delivers **nothing** — it never delivers unverified, and the sender
  retries once the endpoint recovers. Hard to stage in prod; verify in staging by
  blocking B→A egress during a first-contact send.

## Troubleshooting

| Symptom                                                                       | Likely cause                                                                                                                                                                                       |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Send accepted (202) but never arrives                                         | Recipient not open / no allow-rule (default-deny), or the sending instance isn't a peer of the recipient. Check the recipient's mailbox state and both peer lists.                                 |
| Delivery `401` in the sender's outbox                                         | The recipient has the wrong/no instance public key for the sender — re-add the peer with the correct PEM.                                                                                          |
| `403` key mismatch on send                                                    | The recipient pinned a different key for this handle (e.g. the agent was recreated → new identity). No rotation this release.                                                                      |
| `400 agentSig verification failed` after an operator re-registered the handle | The delivered private key does not match the recorded identity. Do not copy, delete, regenerate, or reuse identity keys, and do not clear TOFU pins. Contact an operator for coordinated recovery. |
| Attachment send fails `400`                                                   | Known edge case: attachment filenames containing a double-quote currently fail closed. Rename the file.                                                                                            |
| `ficus remote peers` says "operator-only"                                     | Expected for worker agents (no `amtp:read`) — ask an operator for valid `amtp://` targets.                                                                                                         |

## Teardown

- Operator: revoke handles (mailbox card → **Revoke**) and/or **Close** mailboxes.
- Operator: remove the test peers from **Settings → Federation** on both instances.
- Recreating an agent's sandbox drops its identity (and any pins others hold).
