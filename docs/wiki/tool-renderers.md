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

| File                                         | Purpose                                                    |
| -------------------------------------------- | ---------------------------------------------------------- |
| `apps/web/src/lib/tool-renderers.tsx`        | Registry, renderer definitions, exported components        |
| `apps/web/src/components/ChatView.tsx`       | Uses renderers in `StreamingToolCallItem` (live streaming) |
| `apps/web/src/components/MessageContent.tsx` | Uses renderers in `ToolCallItem` (persisted messages)      |

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

## Streaming arguments

Core streams tool-call arguments as `tool_args_delta` chunks, so while a call runs `args` is usually incomplete JSON. Strict `JSON.parse` is always tried first; a complete call with invalid JSON keeps the raw fallback. While the call is in progress, the incomplete string is read with the `partial-json` parser (unfinished strings, arrays and objects are closed; a key without its value and a cut-off escape are dropped), but only for:

- renderers with `streamingArgs: true` (bash, squad_bash, write, edit, dispatch, ask_human, notify_contact, delegate_task), and
- the generic view for tools without a renderer.

Other renderers keep the raw fallback until their args are complete. Before opting a renderer in, make sure `summary` and `ArgsView` handle any field being missing or cut short, half-built array entries (`{}`, an option without `value`), and ids that change as they stream: key list items by position rather than by streamed values. `navigate` stays off because a half-streamed path would render as a working link.

## Data Format

Tool call data comes from the Pi SDK via SSE streaming:

- **`args`**: JSON-stringified tool parameters, truncated to 2000 chars
- **`result`**: JSON-stringified Pi SDK result object, truncated to 2000 chars. Format: `{"content":[{"type":"text","text":"..."}],"details":{...}}` or a plain string
- **`isError`**: Boolean indicating whether the tool call errored
