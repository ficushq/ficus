# Tool Call Renderers

The tool call rendering system provides purpose-built UI components for displaying Pi SDK tool calls (args and results) instead of raw JSON. It uses a registry pattern so new tools can be added with a single entry.

## Architecture

```
ToolSummary / ToolArgsView / ToolResultView
     │
     ▼
Registry lookup by toolName
     │
     ├─► Known tool  → ToolRenderer.summary / ArgsView / ResultView
     └─► Unknown     → Generic labeled-field args view / raw result
```

## Key Files

| File                                         | Purpose                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------- |
| `apps/web/src/lib/tool-renderers.tsx`        | Registry, renderer definitions, exported components                       |
| `apps/web/src/components/ChatView.tsx`       | Uses renderers in `StreamingToolCallItem` (live streaming)                |
| `apps/web/src/components/MessageContent.tsx` | Uses renderers in `ToolCallItem` (persisted messages)                     |
| `apps/web/src/lib/tool-inline-actions.ts`    | Inline action extractors per tool (see [Inline actions](#inline-actions)) |

## Registry

Each tool renderer implements:

```tsx
interface ToolRenderer {
  // One-line summary shown next to tool name in the header
  summary: (args: Record<string, any>) => string
  // Formatted args display (replaces raw JSON). `partial` is set for a partial parse of streaming args.
  ArgsView: React.FC<{ args: Record<string, any>; partial?: boolean }>
  // Formatted result display (replaces raw JSON)
  ResultView: React.FC<{ result: string; isError: boolean }>
  // Opt in to rendering partially streamed args (see "Streaming arguments")
  streamingArgs?: boolean
}
```

Renderers are registered by tool name in a `Record<string, ToolRenderer>`:

```tsx
const renderers: Record<string, ToolRenderer> = {
  read: readRenderer,
  bash: bashRenderer,
  edit: editRenderer,
  // ...
}
```

## Supported Tools

| Tool        | Summary                          | Args Display                                        | Result Display                  |
| ----------- | -------------------------------- | --------------------------------------------------- | ------------------------------- |
| **read**    | `path:offset-limit` or just path | File path as inline code                            | File content as code block      |
| **bash**    | Truncated command (60 chars)     | Command in dark terminal-style box with `$ ` prompt | Output as code block            |
| **edit**    | Basename (+ edit count)          | Path + each edit's old (red) / new (green) blocks   | Success message + unified diff  |
| **write**   | Basename of file                 | Path + truncated content preview                    | Green success message or error  |
| **grep**    | `"pattern" path`                 | Pattern, path, glob, flags as labeled fields        | Matched lines as code block     |
| **find**    | `"pattern" path`                 | Pattern + path as labeled fields                    | File list as code block         |
| **ls**      | Path (or `.`)                    | Path as inline code                                 | Directory listing as code block |
| _(unknown)_ | _(none)_                         | One labeled field per top-level key                 | Raw JSON pre block              |

## Exported Components

### `ToolSummary`

Renders a one-line summary next to the tool name in the collapsed header.

```tsx
<ToolSummary toolName="bash" args='{"command":"git status"}' />
// renders: "git status" (gray, truncated to 50 chars)
```

Returns `null` for unknown tools or unparseable args. Pass `inProgress` while the call runs so renderers with `streamingArgs` can summarize partially streamed args.

### `ToolArgsView`

Renders the formatted args section when a tool call is expanded.

```tsx
<ToolArgsView toolName="read" args='{"path":"src/main.ts","offset":10}' />
// renders: src/main.ts as inline code
```

Tools without a renderer get a generic view: one labeled field per top-level key, string values verbatim (real newlines) and other values as JSON. The raw `<pre>` block is only the last resort, for args that cannot be parsed at all. `follow` marks the call as in progress: the args box stays pinned to the bottom and partial args are allowed (see below).

### `ToolResultView`

Renders the formatted result section when a tool call is expanded.

```tsx
<ToolResultView toolName="bash" result='{"content":[{"type":"text","text":"output"}]}' isError={false} />
// renders: "output" in a code block
```

Falls back to a raw `<pre>` block for unknown tools.

### `extractResultText`

Helper that parses the Pi SDK result format and extracts plain text:

```tsx
extractResultText('{"content":[{"type":"text","text":"hello"}]}')
// returns: "hello"

extractResultText('plain string')
// returns: "plain string"
```

## Adding a New Tool

1. Define a `ToolRenderer` object with `summary`, `ArgsView`, and `ResultView`
2. Add it to the `renderers` record with the tool name as key

```tsx
const myToolRenderer: ToolRenderer = {
  summary: (args) => args.someField ?? '',
  ArgsView: ({ args }) => <InlineCode>{args.someField}</InlineCode>,
  ResultView: ({ result, isError }) => {
    const text = extractResultText(result)
    return <CodeBlock isError={isError}>{text}</CodeBlock>
  },
}

// In the registry:
const renderers: Record<string, ToolRenderer> = {
  // ...existing tools...
  myTool: myToolRenderer,
}
```

No changes needed in `ChatView.tsx` or `MessageContent.tsx` — they look up renderers by `toolName` automatically.

## Inline actions

A completed tool call can offer small links under its row that open what it created. A collapsed tool/thinking group shows the actions of all its completed calls under its header, in call order and once per target (by `key`); once expanded, they show on the individual rows. Actions appear only for successful, completed calls: not while running, not when the call errored, and not when its result details report `success: false` or an `error`.

| Tool                                              | Action                                 | Source                                                                     | Opens                                                                  | Needs                               |
| ------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------- |
| `monitor` (`create`)                              | Open monitor                           | `details.monitorId`                                                        | Monitor details modal                                                  |                                     |
| `dispatch`                                        | Open `<label>` chat (one per subagent) | `details.subagents[]`                                                      | Subagent conversation modal                                            |                                     |
| `ask_human`                                       | View question                          | `details.questionId`                                                       | Question modal: answerable while open, read-only once answered         | the chat's agent                    |
| `notify_contact`                                  | Open work stream                       | `details.workStreamId`                                                     | The work stream's page in its squad                                    | `workstreams:read`                  |
| `artifact_publish`                                | Open artifact                          | `details.artifactId` (or `details.manifest.id`)                            | Artifact viewer modal                                                  | `artifacts:read`, the chat's agent  |
| `browser_open` with `localDeploymentId`           | Open app                               | `args.localDeploymentId`                                                   | The local app in a new tab, as from the Apps tab                       | `deployments:read`                  |
| `memory_write` / `memory_patch` / `memory_append` | Open note                              | `args.path` (else `details.path`); `targetSquadId` / `squad` for the squad | Memory viewer modal; nothing for a delete (`memory_write` with `null`) | `memory:read` in the note's squad   |
| `bash` / `squad_bash`                             | Open PR #N, Open work stream #N        | `details.createdLinks[]`, set by Core                                      | PR in a new tab; work stream page in-app                               | `workstreams:read` for work streams |

Memory paths are normalized to the memory viewer's `/memory/<rel>` form from a bare squad-relative path or either agent memory root (`/memory/<squadId>/…` or a box's `…/memory/…`); paths outside memory or with `..` segments get no action.

The web client never scans shell output for links. Core adds `details.createdLinks` to a shell result (`apps/core/src/tools/shell-created-links.ts`, wrapped in `AgentSession` between output redaction and the tool firewall) only when the command exited 0, the command text runs `gh pr create` or `ficus workstream|ws create`, and the output has that command's own success line: a PR URL alone on a line, or `Created work stream #N: …`. A command that merely prints a PR URL (`gh pr view`, `cat`) gets nothing.

Inside a chat, `ChatView` provides the agent and squad through `ToolInlineActionScopeProvider`, and each action shows only when the viewer can open it: its `access.permission` in its squad (the note's squad for cross-squad memory writes, else the chat's), plus the chat's agent or squad when the target opens through them. Pull requests and local apps open in a new tab during the click; the other targets open through `ToolInlineActionModal`.

To add an action kind: add it to the `ToolInlineAction` union with its own `label`, `key` and `access`, add an extractor for the tool in `apps/web/src/lib/tool-inline-actions.ts`, and open it in `ToolInlineActionModal` (or in `ChatView`'s click handler when it must open a new tab). The row and group rendering need no changes.

## Streaming arguments

Core streams tool-call arguments as `tool_args_delta` chunks, so while a call runs `args` is usually incomplete JSON. Strict `JSON.parse` is always tried first; a complete call with invalid JSON keeps the raw fallback. While the call is in progress, the incomplete string is read with the `partial-json` parser (unfinished strings, arrays and objects are closed; a key without its value and a cut-off escape are dropped), but only for:

- renderers with `streamingArgs: true` (bash, squad_bash, write, edit, dispatch, ask_human, notify_contact, delegate_task), and
- the generic view for tools without a renderer.

Other renderers keep the raw fallback until their args are complete. Before opting a renderer in, make sure `summary` and `ArgsView` handle any field being missing or cut short, half-built array entries (`{}`, an option without `value`), and ids that change as they stream: key list items by position rather than by streamed values. `navigate` stays off because a half-streamed path would render as a working link.

## Data Format

Tool call data comes from the Pi SDK via SSE streaming:

- **`args`**: JSON-stringified tool parameters, complete (streamed as `tool_args_delta` chunks while the call runs; see above)
- **`result`**: JSON-stringified Pi SDK result object, in full. Format: `{"content":[{"type":"text","text":"..."}],"details":{...}}` or a plain string. Core doesn't truncate it; stored secret values are redacted, and some tools cap their own output (the shell tools' output limit, `web_search`, browser page text), saying so in the text
- **`isError`**: Boolean indicating whether the tool call errored
