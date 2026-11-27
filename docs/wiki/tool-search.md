# Tool search: loading rarely used tools on demand

Agent sessions do not declare every tool on every request. Rarely used, heavy tools are held back and loaded when the agent asks for them, through pi's `tool_search` or, in Claude Code sessions, through Claude Code's own tool search. The code is in `apps/core/src/services/agent/tool-search/`.

## Labels

Every tool is either `direct` (declared on every request) or `deferrable` (may be held back). The label is runtime neutral: pi and the Claude Code bridge read the same labels.

The global default is the tool's `label` in the tool metadata table, `apps/core/src/tools/metadata.ts`, which also holds its replay class (see [restart recovery](restart-recovery.md#tool-replay-classes)). Tools are listed there by exact name; a tool the table does not list, such as an integration or pi extension tool, is `direct`.

The tool groups in `labels.ts` name and describe tools; they do not label them. Each group has a name and a short purpose, which becomes the tool's pi namespace (so `tool_search` matches natural queries such as "screenshot the page") and the line that names the group in the system prompt. Every listed tool in a group has the same default label:

| Group           | Tools                                          | Default      |
| --------------- | ---------------------------------------------- | ------------ |
| Browser         | `browser_*`                                    | `deferrable` |
| Code navigation | `ast_*`                                        | `deferrable` |
| Subagents       | `dispatch`, `check_subagents`, `stop_subagent` | `direct`     |
| Monitors        | `monitor`                                      | `direct`     |
| Checklist       | `todo_*`                                       | `deferrable` |

The subagent and monitor tools are `direct` by default (the shared subagents include tells agents to dispatch); they have a group so an agent type that defers them gets a namespace. Every other tool is `direct`, including `tool_search` itself and the tools the system prompt tells every agent to use by name: `bash`, `squad_bash`, `read`, `write`, `edit`, `ask_human`, `notify_contact`, the memory tools, the short-term memory tools, `sandbox_status`, `set_agent_purpose`, `websearch` and `webfetch`.

An agent type overrides the defaults in its YAML, next to `allow` and `deny` (stored in `agent_types.tool_search`). Sync warns about names in `direct` or `deferred` that match no known Ficus tool:

```yaml
tools:
  allow: [...]
  search: auto # auto | on | off
  direct: [browser_*] # always declared; wins over deferred
  deferred: [webfetch] # may be held back
```

`assistant.yaml` (the fast tier) sets `search: off`; `engineer.yaml` and `manager.yaml` set `search: on`. A subagent inherits its parent's labels along with the tool names it inherits (`SubagentParentExecutionContext.toolSearch`); without a parent override it uses the global defaults, not its own type's.

## The per-session plan

`AgentSession.create` decides a plan once, when a session starts (`planToolSearch` in `plan.ts`):

- `search: off`, no deferrable tools, or (with `auto`) deferrable schemas under `TOOL_SEARCH_MIN_DEFERRED_TOKENS` (2,500 estimated tokens, pi's characters-divided-by-four estimate): mode `direct`, every tool declared, no `tool_search`. A load costs a round trip and, without cache-safe additions, a cache miss, which a small saving does not pay for. With the default labels the deferrable tools of the shipped engineer and manager come to about 1,630 tokens, so `auto` would declare every tool for them. Both types therefore set `search: on`, which holds their browser, code navigation and checklist tools back (on pi sessions, measured at about 1,250 fewer declared tool tokens per request, including `tool_search` and the hidden-tools prompt section; for Claude Code sessions see below); other types can opt in the same way.
- The session's model cannot add tools mid-conversation: mode `direct`. `supportsMidConversationToolAdditions` checks the same model compat flags pi's transports use: Anthropic inline tool changes, OpenAI Responses `additional_tools` or client tool search, Chat Completions tool additions. Every primary model of the shipped tiers supports it; `zai:glm-5.3` does not.
- Any session while a Claude Code account is enabled: mode `claude-code` (below), whatever the session's first model, because per-account and model failover can move a turn onto the Claude Code bridge mid-run. The bridge starts a new Claude Code process only when everything new is a user message, so a tool `tool_search` loaded mid-run would not be callable there until the next user message. A Claude Code account enabled after a session started does not change that session's plan.
- Otherwise mode `search`: the deferrable tools are hidden. `search: on` skips the size check, not the capability check.

The plan is recorded as a `ficus.tool-search` custom entry in the session file and read back on every later turn, resume and compaction, so the starting tool set and the system prompt never change within a session. The same holds for configuration: a change to an agent type's `tools.search`, `tools.direct` or `tools.deferred` reaches only new sessions. Long-lived agents keep one session file, so they pick it up after a session reset. Flow participants built from snapshots taken before this feature carry no override and use the global defaults. A session that already has a conversation but no recorded plan started before this feature and keeps every tool declared. A recorded hidden tool the session no longer has is dropped; a tool added since is declared directly.

Model failover is not part of the decision. On a failover model without cache-safe additions, pi sends the current tools in the top-level tool list, so `tool_search` keeps working and each load costs a cache miss there (a provider switch starts a new cache anyway).

## Search sessions (pi)

- Hidden tools get `exposure: 'deferred'` and their group as `namespace`. The labels are applied to the already wrapped definitions (custom tools and extension tools such as `ast_*`), so the firewall, recovery, output redaction and content-safety wrappers run for a tool whether it was declared up front or loaded later.
- `tool_search` comes from pi's `createToolSearchExtension()`, bound lazily to the session. It ranks the hidden tools with BM25 and activates the matches, which pi records in the transcript as a `toolsAdded` system message; the Responses tool-name adapter (`responses-tool-names.ts`) already rewrites those messages.
- Ficus passes `noTools: 'builtin'`, so pi does not restore a session's active tools from its transcript. `activateToolSearch` does it: `tool_search` plus every hidden tool the transcript declares. The result equals the transcript's tool set, so a resumed turn records no tool change.
- The system prompt gets a "Tools loaded on demand" section (`buildHiddenToolsPromptSection`) that names every hidden tool by exact name, grouped, and says to load them with `tool_search` first, including when instructions or a skill name one of them. It depends only on the set of hidden names, so it is identical on every turn. The section itself says to load a listed tool first when instructions or a skill name it, so the shared prompt includes are not changed (they count against the agent prompt size budgets); the `frontend-visual-review` and `deploy-app` skills repeat it where they name browser tools.

## Claude Code sessions

The Claude Code bridge (`claude-code/bridge.ts`) takes the tool set from the pi transcript and restarts the Claude Code process whenever it changes, so a pi `tool_search` load would restart it. Claude Code sessions therefore never register `tool_search`: pi declares every tool, and the plan's hidden tools are left to Claude Code's own tool search.

- The plan is registered by pi session id (`registerClaudeCodeToolLabels`) for the bridge, which lists direct tools with `_meta['anthropic/alwaysLoad']: true` and deferrable ones with `_meta['anthropic/searchHint']` set to their group's purpose. These are the keys the Claude Agent SDK's `tool()` helper sets (SDK 0.3.329).
- `ENABLE_TOOL_SEARCH` is `true` when the plan holds tools back and `false` otherwise, so `search: off` and sessions under the size threshold declare every tool, as pi does for those sessions.
- A session that holds tools back starts Claude Code with its built-in `ToolSearch` tool available and pre-approved (`tools: ['ToolSearch']`, and `ToolSearch` in `allowedTools`). No other Claude Code built-in tool is available. Without `ToolSearch` Claude Code has nothing to search with and declares every tool up front, whatever `ENABLE_TOOL_SEARCH` and the `_meta` labels say; sessions that hold nothing back keep `tools: []`.
- So a bridge session's first request declares `ToolSearch` and the direct Ficus tools only. The model loads a held-back tool by calling `ToolSearch` (for example `select:mcp__ficus__todo_add`); Claude Code declares it on the next request and the call reaches the MCP server and pi like any other Ficus tool call, through the same wrappers.
- `ToolSearch` calls are Claude Code's own. The bridge's turn translator (`TurnTranslator.internalTools` in `claude-code/convert.ts`) leaves their `tool_use` blocks out of pi's assistant message, and a model response whose only tool calls are `ToolSearch` does not end the pi turn: Claude Code answers the search and asks the model again, and that response continues the same pi message (its usage is added to the first's). pi's transcript therefore has no tool call or result for a search, nothing runs in pi, and nothing counts against the recovery budget. The anchor is the last response's id, so the next turn continues the same Claude Code process. Any other tool name Claude Code reports is still recorded as `claude-code-unknown:<name>`, as is `ToolSearch` in a session that was not offered it.
- The labels, `ENABLE_TOOL_SEARCH` and whether `ToolSearch` is offered are part of the bridge signature. They are fixed for the session, so they never cause a restart; loading a tool through Claude Code's search does not change pi's tool set. A live session restarts (resumed) at most once, when a deploy changes them.
- No Ficus hidden-tools section is added: Claude Code lists its deferred tools itself, and the model should not see two different search tools.

Measured live on 2026-11-27 (`claude` 2.1.332, `claude-opus-5-5`, one engineer session with `search: on`, recorded in the PR 1100 review): with `tools: []` the first request declared all 17 Ficus tools and none was deferred, so `search: on` saved nothing on the bridge. With `ToolSearch` offered, the first request declared only `ToolSearch`, `mcp__ficus__ask_human` and `mcp__ficus__bash`, so `anthropic/alwaysLoad` is honoured. A `ToolSearch` call loaded `todo_add` and `browser_screenshot`, both calls reached the tools, and `ask_human` was callable without a search. Before the bridge kept `ToolSearch` internal, pi recorded each search as a failed `claude-code-unknown:ToolSearch` call.
