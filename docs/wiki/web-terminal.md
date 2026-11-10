# Web terminal and log viewers

The web app renders three xterm.js (`@xterm/xterm` 6) surfaces:

- the interactive sandbox terminal, `apps/web/src/components/workspace/Terminal.tsx`, which forwards `onData` bytes unchanged over the terminal WebSocket to the session shell (Bash, using the managed bootstrap described in [host-runtime.md](host-runtime.md));
- the read-only system logs, `components/settings/SystemLogsSection.tsx`;
- the read-only sandbox logs, `components/squads/SandboxLogs.tsx`.

Colors come from the theme tokens through `apps/web/src/theme/terminal.ts`; see the [theme adapter contract](../../apps/web/src/theme/README.md).

## Keyboard: Alt+arrow word movement

xterm 6 removed the library's Alt+arrow translation ([xtermjs/xterm.js PR 5346](https://github.com/xtermjs/xterm.js/pull/5346)) and now sends the standard `ESC [1;3D`/`C`/`A`/`B` sequences. The interactive terminal restores the exact xterm 5.5 bytes with a custom key handler (`components/workspace/altArrowKeys.ts`), so word movement works the same in every shell and program, not only in those that bind the new sequences:

| Key (Alt only, no other modifier) | Linux and Windows | macOS               |
| --------------------------------- | ----------------- | ------------------- |
| Alt+Left                          | `ESC [1;5D`       | `ESC b`             |
| Alt+Right                         | `ESC [1;5C`       | `ESC f`             |
| Alt+Up                            | `ESC [1;5A`       | `ESC [1;3A` (xterm) |
| Alt+Down                          | `ESC [1;5B`       | `ESC [1;3B` (xterm) |

Every other modifier combination is left to xterm, whose output for those keys did not change between 5.5 and 6. The handler cancels the browser default, as xterm does for keys it handles, so Alt+Left never navigates back in history. Read-only log viewers take no input and need no handler.

Bash 5.2 with its default key bindings binds both `ESC [1;3D`/`C` and `ESC [1;5D`/`C` to word movement, so the shell would also have worked without the handler; other readers such as zsh, older readline versions, editors and REPLs do not always bind the new sequences.

## Scrollbar

xterm 6 draws its own scrollbar slider instead of the native viewport scrollbar. The `--term-scrollbar-thumb`, `--term-scrollbar-thumb-hover` and `--term-scrollbar-thumb-active` tokens map to the slider's normal, hover and active colors, so a theme that sets them looks as it did with xterm 5.5. The built-in themes keep `auto`, which leaves xterm's default slider: the terminal foreground at 20%, 40% and 50% opacity over the terminal background. With xterm 5.5, `auto` showed the browser's native scrollbar instead, whose look depended on the operating system and the page's light or dark color scheme; xterm 6 can no longer show it. Log viewers always use the default slider.
