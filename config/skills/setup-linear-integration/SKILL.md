---
name: setup-linear-integration
description: Set up Linear through Ficus Integrations, assign accounts to squads, and configure issue routing or workflow triggers.
---

# Setting up Linear

Help the user configure **Settings → Integrations → Linear**. Manage credentials only in that integration card. Never ask the user to paste a private API key, client secret or signing secret into a chat.

Linear offers two kinds of connection, and a squad uses one of them:

- **Agent app (recommended).** Ficus is installed in the Linear workspace as its own app member, so people can delegate issues to it and mention it, and everything the CLI writes appears as the app. It uses OAuth; tokens refresh automatically.
- **Personal API key.** Ficus acts as the person who owns the key. Mainly for self-hosted instances that do not set up their own Linear app.

## Installing the agent app

The **Agent app** section is always shown in the Linear card. If a Ficus Cloud install reports that the hosted Linear app is not set up for the instance yet, the Platform side has no Linear application configured: use a personal API key until it is. On a self-hosted instance, the install button appears only after the Linear application settings are saved.

1. Enable Linear globally.
2. On Ficus Cloud, open **Agent app** in the Linear card and choose **Install Ficus in Linear**. Self-hosted instances first need their own Linear OAuth application:
   1. In Linear's API settings, create an OAuth application (any name; it appears in Linear under that name).
   2. Copy the **Callback URL** shown in Ficus into the application's redirect URIs, and the **Webhook URL** into its webhook URL. Turn on webhooks with the categories Agent session events, Inbox notifications, Permission changes, Issues and Comments.
   3. In Ficus, enter the application's client ID, client secret and webhook signing secret, confirm the settings, and save. Saved secrets cannot be revealed; **Replace application settings** overwrites all three.
   4. Choose **Install Ficus in Linear**. The instance needs a public URL for the callback.
3. A Linear workspace admin approves the install. The connection appears as `<Workspace name> (Ficus app)`. Installing again in the same workspace updates that connection.
4. Enable the connection and assign it to squads, as below. If it shows **Reconnect required**, choose **Reconnect** on it.

Uninstalling the app is done in Linear's settings; removing the connection in Ficus only revokes its token.

## Using a personal API key

1. Enable Linear globally. Add an account name and personal API key. In Linear, create the key under Security & Access, with read and write access to the intended teams. Read access is enough for routing and search; agents need write access to create, update and comment on issues.
2. Validate and enable the account. An imported legacy account starts disabled and needs validation before use.
3. Open the squad’s **Integrations → Linear** card, enable it for the squad, and select the account. Configure the Linear team IDs whose assigned issues should notify this squad’s manager.
4. Expand **Webhook delivery** in global Linear settings. Copy its URL into a Linear webhook configured for Issue updates. Enter the same signing secret in Linear and Ficus. Saved signing secrets cannot be revealed; replace both to rotate.
5. Check `ficus webhook status linear` and assign an issue to the connected account’s user. Ficus checks that the connected account can read the issue, belongs to the expected team, and is still the assignee before routing it.

No separate `LINEAR_USER_ID` is needed: identity comes from the connected API key or app. Moving a squad from a key to the app is a normal reassignment in its Integrations card; tracked issues keep matching. Multiple squads may select the same connection, or choose separate accounts.

## Routing and flows

Existing team routing remains available:

```bash
ficus squad set-meta <squad-id> linear '[{"teamId":"team-id"}]'
```

Only a squad with an enabled, assigned Linear connection receives these events. For declarative routing, use the typed outputs `linear / issue.assigned`, `issue.unassigned`, `issue.updated`, and `issue.comment` (all `version 1`) in workflow subscriptions or squad event triggers. Match `issue.id`, `issue.identifier`, `teamId`, `assignee`, `action`, or `state` as needed. A handled flow event does not also produce the legacy manager notification for that squad. Ficus checks each assigned squad's own connection can currently read the issue before delivering it, independent of any other squad's connection.

## Tracking issues on work streams

`ficus workstream track <ws-id> --issue KEY-123` (or `--url <linear issue url>`) links a work stream to a Linear issue through the squad's Linear connection — the same command used for GitHub issues and PRs. Linear has no pull requests, so `--pr` and `--delivery` are rejected for a Linear reference. A squad-level Linear notification (or `ficus workstream create --from-event <id>`) carries an `Event reference:` block naming the issue the same way GitHub notifications do — including comment notifications, which name the issue by its Linear id and are resolved through the squad's Linear connection when the link is made. See `docs/wiki/linear-integrations.md` (Tracked issues) for identity and linking details.

Ficus attaches a stream's delivery pull request to its tracked Linear issues. The squad's **Pull request links** setting (Integrations tab, Linear section, or `ficus squad set-meta <squad> integrationSettings.linear '{"version":1,"pullRequestLinks":{"origin":"closes","tracked":"links"}}'`) picks the link kind: `closes`, `contributes` or `links` for the issue the work started from (default `closes`) and for other tracked issues (default `links`). With the Ficus app, a bound agent session also gets the stream's progress; `ficus workstream track <ws-id> --issue KEY-123 --linear-session` opens and binds one for a stream that was not started from Linear. See `docs/wiki/linear-integrations.md` (Progress write-back).

For live issue search, enable the squad’s Linear connection. Memory grants may further restrict team keys, but cannot grant access beyond the connected account.

## Agent CLI

Once the squad has an enabled, assigned connection, its sandbox installs the pinned `linear` CLI and agents get the `linear` skill. No login or other setup is needed: each `linear` command receives the connection's credential for that command only (the raw key, or `Bearer <token>` for the app). Never run `linear auth login` in a squad sandbox. To check it, run `linear --version` (it should report `linear 3.1.0`) and then `linear issue view KEY-123 --json` on an issue the key can read. If the connection is detached or disabled, `linear` fails rather than using another account. To run any other command with the selected key, use `ficus integration exec linear --squad <id> -- <command>`; credentials are injected for that command and should never be printed. See `docs/wiki/linear-integrations.md` (Agent CLI).

Troubleshoot in order: global enable, account validation and enable (for the app: the Linear application settings, then **Reconnect**), squad enable and assignment, team routing, webhook signing secret, and current issue assignee. For the CLI, also check the sandbox setup status (readiness `linear-cli`) and whether the key has write access.
