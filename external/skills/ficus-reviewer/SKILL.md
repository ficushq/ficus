---
name: ficus-reviewer
description: Use when running an agent session as a standing reviewer for Ficus squads — blocking on `ficus watch` for attention changes, acting on each event with the `ficus` CLI, and watching the squad's GitHub PRs with a `gh` sidecar. Requires the `ficus` skill.
---

# Reviewing Ficus squads (`ficus watch`)

You are a standing reviewer: a long-lived session that wakes only when a
Ficus squad needs a human-shaped decision, handles it with the `ficus` CLI, and
goes back to waiting. This skill covers the waiting and the triage. The
verbs you act with — `ws approve`, `ws send-back`, `ws unblock`, `aq answer`,
`inbox send` — and the doctrine behind them live in the `ficus` skill, which
you must have installed and read first. Nothing here overrides it.

## Prerequisites

```bash
ficus skill install ficus --agent <agent>            # the operator skill (read it)
ficus skill install ficus-reviewer --agent <agent>   # this skill
ficus auth status                                # a paired backend for the instance
ficus watch --timeout 5 --json                   # must print {"events": []} and a cursor
```

`ficus watch` is NOT `ficus ws watch <id>`. The latter adds you to one stream's
notification list. `ficus watch` blocks your process until anything on your
attention surface changes.

## What `ficus watch` reports

It compares snapshots of three read-only surfaces — your pending actions,
your unread inbox messages (from agents, the system, remote peers, or people), and the active/queued work streams you
can see — and prints only what changed. It never reports pre-existing state
and never writes anything.

```bash
ficus watch --json                    # block until a change, print it, exit 0
ficus watch --json --cursor "$CURSOR" # baseline = an earlier result: exact chaining
ficus watch --json --follow           # never exit; one JSON line per change batch
ficus watch -q <squadId>              # one squad only
ficus watch --timeout 900             # one-shot: {"events": []} after 15 min of quiet
ficus watch --poll 60                 # fallback re-check; WebSocket hints are the fast path
```

Every result is `{ at, cursor, events[] }`. Carry `cursor` into the next
call or you will miss anything that happened while you were acting. Every
event has a content-addressed `key`: the same condition never fires twice,
and if a batch is replayed after a crash you dedupe on `key`.

| kind                             | meaning                                                                                                                     | do                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workstream.wait`                | a stream opened or changed an open wait (`waitType` review/manual/question/dependency, `message` is the resume condition)   | Read `message`. Review wait whose condition holds → `ficus ws approve`; needs another round → `ficus ws send-back -m`. Manual wait you can answer → `ficus ws unblock -m`. Question/dependency waits resolve themselves — do nothing.                                                                                                                                                                                                                                                                                                                                            |
| `action.pending`                 | a pending action needs a response (`type` agent-question, squad-question, agent-error, assistant-needs-input; `canRespond`) | `ficus action list`, then `ficus aq answer <id> "<precise answer>"` for questions; for `agent-error`, check machine health through the manager before touching code. `assistant-needs-input` is a task from the owner's private Assistant conversation waiting on the owner's own answer (`data.question`, `data.conversationTitle`), not squad work: leave it for the human unless they told you to answer for them, then reply in that conversation (`ficus search "<title>" --kind assistant_conversation --json` gives its `agentId`; `ficus chat -a <agentId> "<answer>"`). |
| `inbox.message`                  | a message reached your inbox (`senderType` agent/system/remote/user, `senderId`, `subject`)                                 | `ficus inbox list --json`, read it, `ficus inbox read <id>`. System notices (fleet alerts, stream lifecycle) are read-only context; reply to agents through the manager unless they asked you directly.                                                                                                                                                                                                                                                                                                                                                                          |
| `workstream.created`             | a new active/queued stream appeared                                                                                         | Usually nothing; note it for context.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `workstream.done` / `.canceled`  | a stream reached a terminal state                                                                                           | Nothing, unless you were tracking a PR for it (see sidecar).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `workstream.idle`                | `--follow` only: active, no execution, no wait for 10 min                                                                   | Ask the manager for execution state before concluding anything. Idle is the one alarming display, but managers sequence work deliberately.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `health.degraded` / `.recovered` | three consecutive snapshot failures / first success after                                                                   | Infrastructure check (`ficus auth status`, instance reachability), not a code problem. Keep the cursor; do not re-baseline.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

## The loop

**One-shot, cursor-carried** — for a harness that runs one tool call per
turn. Give `--timeout` a value shorter than the harness's tool timeout, or
the call is killed and the cursor is lost.

```bash
CURSOR=""
while :; do
  OUT=$(ficus watch --json --timeout 600 ${CURSOR:+--cursor "$CURSOR"}) || break
  CURSOR=$(printf '%s' "$OUT" | jq -r .cursor)
  printf '%s' "$OUT" | jq -c '.events[]'        # act on each; empty means quiet
done
```

**Follow** — for a harness that can stream a background process into the
session. Each line is one batch; persist the last `cursor` so a restart
resumes exactly.

```bash
ficus watch --json --follow | while IFS= read -r line; do
  printf '%s' "$line" | jq -r .cursor > ~/.ficus/reviewer.cursor
  printf '%s' "$line" | jq -c '.events[]'
done
```

Restart with `--cursor "$(cat ~/.ficus/reviewer.cursor)"` after a crash.

## GitHub sidecar

PR activity is not in Ficus. Poll it beside `ficus watch` with `gh` using the
filters below — they exist because CI counters, bot chatter, and your own
comments woke reviewers dozens of times a day for nothing.

Configure: `FICUS_REVIEW_REPO` (`owner/name`), `FICUS_REVIEW_AUTHOR` (the
squad's GitHub login, e.g. the bot account agents push as),
`FICUS_REVIEW_SELF` (your own login; your comments are never events).

```bash
# Normalize open PRs to {number, head, state, draft, ready, failed{}, comments{}}
gh pr list --repo "$FICUS_REVIEW_REPO" --author "$FICUS_REVIEW_AUTHOR" --state open --limit 200 \
  --json number,headRefOid,state,isDraft,statusCheckRollup,comments,reviews |
jq --arg self "$FICUS_REVIEW_SELF" --arg author "$FICUS_REVIEW_AUTHOR" '
  def relevant: (.statusCheckRollup // [])
    | (map(.name // "") | any(startswith("test / "))) as $lanes
    | map(select(
        (($lanes and .name == "test") | not) and
        ((.name // "") | test("diagnostics|\\[code\\]smith|macOS portability suite") | not)));
  def outcome: (.conclusion // .state);
  def actor: (.author.login // .user.login // "");
  def human: actor as $a | $a != "" and $a != $self and
    ($a == $author or (($a | test("\\[bot\\]$") | not) and
      ($a | IN("blacksmith-sh", "codesmith") | not) and
      (.user.type != "Bot") and (.author.__typename != "Bot")));
  map({
    number, head: .headRefOid, state: (.state // "OPEN"), draft: (.isDraft // false),
    ready: ((relevant | length) > 0 and (relevant | all(outcome | IN("SUCCESS","SKIPPED","NEUTRAL")))),
    failed: (relevant | map(select(outcome | IN("FAILURE","TIMED_OUT","CANCELLED","ACTION_REQUIRED","ERROR")))
      | map({key: (.name // .context), value: (.detailsUrl // .targetUrl // outcome)}) | from_entries),
    comments: (((.comments // []) + (.reviews // [])) | map(select(human))
      | map({key: (.id | tostring), value: ((.body // "") + " " + (.state // ""))}) | from_entries)
  })'
```

Keep the previous normalized array; on each poll compare per PR and act on:
a PR you have not seen (new PR), `head` changed (re-review), `state`
changed (merged/closed — resolve the stream's merge-gate wait if its
condition is met), `draft` → not draft (ready for review), `ready` false →
true (CI green), a `failed` entry new or with a new URL (a check failed —
send-back with the URL), a `comments` entry new or changed (someone other
than you wrote or edited something — read it). Inline review comments
(`gh api repos/$FICUS_REVIEW_REPO/pulls/<n>/comments`) count as comments too.
A previously open PR missing from the list may have merged: `gh pr view <n>`
before deciding.

**The completing review wait is a merge gate, not an LGTM.** CI green is
not merged. Approve the stream's completing wait only when the PR is
actually merged (or the wait's stated condition is otherwise met);
`send-back` is always safe.

## Doctrine

1. **`ficus watch` has no write authority and neither does the sidecar.**
   Everything you do happens through the `ficus` verbs and GitHub, deliberately,
   one event at a time.
2. **Never drop the cursor casually.** Starting without `--cursor` baselines
   to "now" and silently forgets everything that happened while you were
   away. Re-baseline only when you have decided the backlog is not worth
   working.
3. **Dedupe on `key`.** A crash between reading a batch and acting on it can
   replay events; the key is stable, so a seen key is a handled event.
4. **Don't infer stalls from timestamps.** A `workstream.idle` event is a
   prompt to ask the manager, not a verdict. Parked-with-wait is the system
   working.
5. **`health.degraded` is an infrastructure signal.** Check reachability and
   auth first; do not "fix" agent code because polling failed.
6. **Precise resolutions.** Every `approve`, `send-back`, `unblock`, and
   `aq answer` note states what changed, what to do next, and any new
   constraint — the resumed agent reads it as its next instruction.
