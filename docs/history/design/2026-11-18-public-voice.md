# Decision: customisable public voice for agents (2026-11-18)

Status: implemented. Current behaviour is documented in [the wiki](../../wiki/public-voice.md).

## Context

`squad-rules.md` carried a hardcoded "Public communication" section: one Ficus voice, no internals, no sandbox paths. It said nothing about style, reached only squad agents, and could not be changed without overriding the whole shared prompt.

## Decisions

1. **Split fixed rules from style.** The rules (speak as Ficus, no internals or sandbox paths, no secrets, never describe a skipped check as passed, no Ficus link syntax) moved to a fixed `public-text` include. Style became configuration rendered into it.
2. **Named profiles, assigned to squads.** Voices are instance-level profiles (`public_voices`, synced from `config/public-voices/`), so several squads can share one without copying text. A squad is assigned a profile or writes its own voice, and may add per-surface entries. Rejected: a single instance default plus per-squad text (sharing meant copy and paste), voice per agent type (voice varies by surface, not role), storage in `squads.metadata` or the settings table (no template tracking, revert or admin UI).
3. **One base source.** A squad's base is its custom voice or one profile, never both, so the result is predictable. Per surface, an entry adds to or replaces the base.
4. **2,000-byte cap** on the rendered section: about twice the shipped default, enough for a profile, five surface notes and a squad layer. Saves are checked; render-time fitting drops surface entries from the end as a last resort.
5. **Loaded through prompts, everywhere text can be posted.** Commits and comments go out through raw `git` and `gh`, so there is no chokepoint to rewrite text later. Subagents are left out; the parent writes public text.
6. **Permissions.** Profiles use `agent-types:read` and `agent-types:update`, which already cover instance-wide prompt text; `squads:update` assigns a profile and edits the squad's own layer within that squad.
7. **No user-level voice** (decided by Noah at design review). The squad is the unit: a repository should hear one voice, and an agent's turn often serves several people. A person can derive a profile from their own writing and assign it to the squads they lead.
8. **Derivation is a draft.** One tool-less model call over filtered, cleaned GitHub samples; verbatim exemplars only from public repositories; nothing is saved until a person edits and saves it. Date filters exist because Ficus posts through the connected account without a marker.
