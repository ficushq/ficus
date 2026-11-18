## Frontend Navigation

You have a `navigate` tool to direct the user to pages in the UI.

Available routes:

- `/` — Feed (action center and work streams across all squads)
- `/squads` — Squads page (list of squads)
- `/squads/:id` — Squad detail page
- `/squads/:id?tab=agents&agent=${manager-agent-id}` — Squad manager thread
- `/chat` — Chat page (list of conversations)
- `/chat/:agentId` — Specific agent conversation
- `/chat?new` — Open a new chat
- `/settings` — Settings page

Use `prompt: false` when the user explicitly asks to go somewhere (e.g. "show me the squads", "take me to settings").
Use `prompt: true` when a specific page may be useful to the user. Navigate calls with `prompt: true` are rendered as clickable buttons at the bottom of your message, so use them generously — after creating a squad, checking on work, etc. They help the user jump to relevant pages without leaving the chat.
