# Host slot budget

How squads that share a machine host take turns at heavy work.

## Why

A [slot pool](../cli/README.md#slot-coordination-commands) limits how many
agents of one squad do something at once. On the VM runtime several squads
share one machine host, so each squad's own limit says nothing about the total:
three squads with a limit of two each can run six heavy jobs on one host, and a
squad with no pool is not limited at all. The
[memory model](memory-model.md) contains the damage when a box overruns; the
host slot budget keeps squads from all starting heavy work at the same time in
the first place.

## Host-shared pools

A pool is **host-shared** unless it is told not to be. A claim on a host-shared
pool needs two free units:

- one in the pool, as for any pool, and
- one in the **host budget** of the machine the squad's box is on. Every
  host-shared pool of every squad on that machine draws on the same budget.

It is still one claim, one release and one timeout. An agent can be queued
while its own pool has room, and the claim answer says so:

```
The machine host's shared slot budget is full (3 of 3 in use across squads); you are queued for "heavy-work".
```

`ficus slot list` shows the budget next to the pool, and `availableCount` never
exceeds what the host has free. Agent prompts say which pools are host-shared
and how many such claims the host allows.

New pools are host-shared by default, because most pools protect box memory or
CPU (builds, test suites, dev servers, browser runs, Compose stacks) and one
that is wrongly left out is exactly the work that overloads a host. Turn it off
for a pool that protects something else, such as a deployment lock or one
squad's infrastructure stack: `ficus slot register <key> --no-host-shared`,
`ficus slot update <key> --no-host-shared`, or the checkbox in Squad Settings →
Slot Pools. Left on, such a lock would take a unit of the machine while it is
held and would itself wait whenever the machine is busy, for no benefit.

Pools registered before host sharing existed are not host-shared until someone
turns it on (`ficus slot update <key> --host-shared`), so an upgrade changes no
existing pool.

A squad with no machine (k8s, Docker and host runtimes, or a squad whose box
was never placed) has no host budget. Its host-shared pools behave like
ordinary pools.

### No cap of its own

A host-shared pool's own capacity still limits its squad. A pool can drop that
cap (`ficus slot update <key> --capacity host`, `register --capacity host`, or
**No cap of its own** in the settings form): its capacity is then the machine's
budget, read on every claim, so it follows a resized host or a changed budget
setting with nothing to update. `ficus slot list` and the API report that
number as the pool's capacity. Passing a number again (`--capacity 2`) gives the
pool its own cap back. The number the pool stored before stays as the fallback
for where no budget applies (budgets turned off, a machine of unknown size).

## The budget

Each machine's budget is derived from its size
(`deriveHostSlotCapacity`, `apps/core/src/services/slots/host-budget.ts`):

1. Take the machine's memory and subtract the host's own reserve, the larger of
   512 MiB and 10% (the reserve of the [memory model](memory-model.md)).
2. One unit per 4 GiB of what is left.
3. Never more than one unit per CPU, and never fewer than one.

| Machine       | Budget |
| ------------- | ------ |
| 2 GB, 1 CPU   | 1      |
| 4 GB, 2 CPUs  | 1      |
| 8 GB, 4 CPUs  | 1      |
| 16 GB, 4 CPUs | 3      |
| 32 GB, 8 CPUs | 7      |
| 64 GB, 4 CPUs | 4      |

A machine whose memory Ficus does not know has no budget.

**Settings → System → Machine host slot budget** (`HOST_SLOT_CAPACITY`)
overrides this for every machine: a number fixes the budget, and 0 turns host
budgets off, so host-shared pools are limited only by their own capacity. It
takes effect on the next claim, without a restart. With nothing stored, the
`FICUS_HOST_SLOT_CAPACITY` environment variable applies in the same way, and
with neither, the derived budget. Under the control, Settings shows what each
machine's size derives to right now, whatever is stored.

## Who gets the next unit

Waiters on one machine are ordered across squads:

1. **Priority**, from the agent's active work streams, raised by aging (below).
2. **Fair share**: the squad that holds fewer of the machine's units goes
   first. A squad alone on the machine can still use all of it.
3. **First come.**

A pool's own promotion leaves the machine's unit free when another squad's
waiter is better placed, and that squad's pool is promoted right after the
transaction commits (`promoteHostGroup`). A new claimant never takes a unit
another squad is already queued for; it queues and is ordered with everyone
else. The 30 second slot reconciliation repeats the promotion, which also
covers units freed outside a pool operation (a holder going dormant, a squad
being archived).

Grants against one machine are serialized by an advisory lock taken after the
pool row lock, so two squads can never take the same last unit.

## Aging

In every pool, host-shared or not, a waiter gains one priority level for each
30 minutes it has been queued, up to critical
(`SLOT_WAIT_AGING_INTERVAL_MS`, `queue-order.ts`). Without it a low-priority
waiter never reached the front of a pool that higher-priority work kept busy.
Within a level the order is still first come, so an aged waiter goes ahead of
newer waiters of the level it has reached.

## Waiting is visible, and is not a stall

An agent that queues ends its turn and waits for the grant, so its work stream
has no running execution for a while. That wait is shown and is never reported
as a stall:

- The work stream reads **Waiting for heavy-work slot (position 2 of 5, host
  busy)** in lists, the Activity "Active work" rows, the flow panel's current
  step and `ficus workstream list`/`get`, and returns to its ordinary state on
  grant. See
  [work-stream status presentation](../work-stream-status-presentation.md#resource-subscriptions-and-ordinary-idle).
- The squad stall alert leaves a queued attempt out for as long as it stays
  queued. An abnormally long queue raises its own alert instead: see
  [long capacity waits](../fleet-stall-alerts.md#long-capacity-waits).

Both report another squad only as a count of the host units it holds.

## The default pool

Slot pools are opt-in, so a squad whose manager never registered one ran its
heavy work ungated. A squad whose box is on a machine with a budget, and that
has no slot pool at all, is given one (`ensureDefaultHostPools`,
`default-host-pool.ts`, on the reconciliation interval):

- key `heavy-work`, host-shared, 45 minute claim timeout,
- no cap of its own, so its capacity is the machine's budget and stays so,
- usage guidance naming dev servers, builds, full test suites, browser runs,
  Compose stacks and local databases.

A squad that already has pools is left alone: turn host sharing on for the pool
that protects box capacity instead. The manager can edit, disable or unregister the
default pool like any other. Once unregistered it is not registered again: its
row is kept as the record of that decision.
