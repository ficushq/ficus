# Memory Sync

Memory files can be synced to external storage, enabling version history, backup, and sharing across environments.

## Providers

### Git

Syncs the memory directory to a Git repository via SSH or HTTPS.

```typescript
{
  type: 'git',
  repoUrl: 'git@github.com:org/memory.git',
  branch: 'main',
  pathPrefix: '',           // optional subdirectory in repo
  sshKeyName: 'github',    // SSH key from squad's key store
  autoPull: true,           // pull on schedule
  autoPush: true,           // push on changes
  webhookSecret: '...'      // optional, for push event webhooks
}
```

**Pull**: Clones or fetches the repo, detects conflicts via merge-base, stashes local changes if needed.

**Push**: Stages all changes, commits with timestamp message, pushes to origin.

**Webhooks**: Git providers can send push events to trigger immediate pulls instead of waiting for the poll interval.

**Host key**: an SSH remote is used only after a person trusts its host key in Memory settings (existing remotes adopt the key already trusted). Git connects with strict checking against that key only; see [SSH host keys](../ssh-host-keys.md).

### S3

Syncs to an S3 bucket (or S3-compatible storage like MinIO).

```typescript
{
  type: 's3',
  bucket: 'my-memory-bucket',
  region: 'us-east-1',
  endpoint: '',             // optional, for MinIO etc.
  pathPrefix: 'squad-a/',   // optional prefix in bucket
  credentialsRef: 'aws',    // credentials from secret store
  autoPull: true,
  autoPush: true
}
```

**Change detection**: Uses ETags (MD5 hashes) to detect remote changes. Maintains sync state in `_system/s3-sync-state.json`.

**Conflict handling**: Detects when both local and remote have changed since last sync. Respects the configured `conflictPolicy` (`manual` or `last_write_wins`).

## Sync Flow

```
File change in memory/
        │
        ▼
ReindexScheduler (60s debounce)
        │
        ▼
Reindex memory files
        │
        ▼
SyncService.schedulePush() (5s debounce)
        │
        ▼
Push to all configured providers
```

Pulls happen on a configurable interval (`pullIntervalMinutes`) or immediately via webhook.

## Configuration

```typescript
sync: {
  providers: [...],
  conflictPolicy: 'manual',      // or 'last_write_wins'
  pushDebounceSeconds: 5,         // debounce rapid changes
  pullIntervalMinutes: 15         // polling interval
}
```

## Implementation

- Service: `apps/core/src/services/memory/sync/SyncService.ts`
- Git adapter: `apps/core/src/services/memory/sync/GitAdapter.ts`
- S3 adapter: `apps/core/src/services/memory/sync/S3Adapter.ts`
- Types: `apps/core/src/services/memory/sync/types.ts`
