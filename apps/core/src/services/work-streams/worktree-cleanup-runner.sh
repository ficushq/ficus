#!/bin/sh
# Inlined at build time. The caller must durably fence this owned worktree before
# dispatch. An interrupted operation without a receipt is NOT permission to retry
# removal or reuse the path. This script never expires an operation identity.
exec bun - "$1" "$2" <<'BUN_SCRIPT'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const input = JSON.parse(process.argv[2]);
const { ownership: o, head, operationId } = input;
const digest = crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
const fail = (reason) => { throw new Error(reason); };
const inside = (root, child) => child.startsWith(root + '/');
const exists = (p) => { try { fs.lstatSync(p); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const physical = (p) => { if (fs.realpathSync(p) !== p) fail('Canonical path changed'); };
if (!/^[0-9a-f-]{36}$/.test(operationId) || !/^[0-9a-f]{40}$/.test(head)) fail('Invalid operation identity');
for (const key of ['workspace', 'repository', 'commonDirectory', 'gitDirectory', 'worktree']) {
  if (typeof o[key] !== 'string' || !path.isAbsolute(o[key]) || path.normalize(o[key]) !== o[key]) fail('Invalid owned path');
}
if (!inside(o.workspace, o.repository) || !inside(o.workspace, o.commonDirectory) ||
    !inside(o.workspace, o.worktree) || o.worktree === o.repository ||
    o.worktree === o.commonDirectory || inside(o.commonDirectory, o.worktree) ||
    !inside(o.commonDirectory + '/worktrees', o.gitDirectory)) fail('Unsafe worktree ownership');
physical(o.workspace); physical(o.repository); physical(o.commonDirectory);
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
env.GIT_CONFIG_NOSYSTEM = '1'; env.GIT_CONFIG_GLOBAL = '/dev/null';
const runGit = (dir, args, stdin) => {
  const result = Bun.spawnSync(['git', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', dir, ...args], { env, stdin: stdin === undefined ? 'ignore' : Buffer.from(stdin), stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) fail('Git safety check or removal failed; retain for inspection');
  return result.stdout.toString();
};
const git = (dir, ...args) => runGit(dir, args);
if (git(o.repository, 'rev-parse', '--show-toplevel').trim() !== o.repository ||
    git(o.repository, 'rev-parse', '--path-format=absolute', '--git-common-dir').trim() !== o.commonDirectory)
  fail('Repository identity changed');
const records = path.join(o.commonDirectory, 'tau-worktree-cleanup');
try { fs.mkdirSync(records, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
physical(records);
const active = path.join(records, operationId);
const receipt = path.join(active, 'receipt.json');
const replay = () => {
  physical(active); physical(receipt);
  const result = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  if (result.digest !== digest || result.operationId !== operationId) fail('Cleanup receipt identity mismatch');
  console.log(JSON.stringify(result));
};
if (exists(active)) { replay(); process.exit(0); }
if (process.argv[3] === 'probe') fail('No terminal cleanup receipt; keep the reuse fence');
try { fs.mkdirSync(active, { mode: 0o700 }); }
catch (e) { if (e.code !== 'EEXIST') throw e; replay(); process.exit(0); }
// Persist the exclusive claim before any destructive action. A duplicate may
// read a terminal receipt, but never takes over an interrupted active record.
for (const directory of [o.commonDirectory, records, active]) {
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
let removalStarted = false;
let outcome;
try {
  physical(o.worktree); physical(o.gitDirectory);
  const identity = fs.lstatSync(o.worktree, { bigint: true });
  if (!identity.isDirectory() || `${identity.dev}:${identity.ino}` !== o.directoryIdentity) fail('Worktree directory identity changed');
  if (!fs.lstatSync(path.join(o.worktree, '.git')).isFile()) fail('Expected a linked worktree, not a primary checkout');
  if (git(o.worktree, 'rev-parse', '--show-toplevel').trim() !== o.worktree ||
      git(o.worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir').trim() !== o.commonDirectory ||
      git(o.worktree, 'rev-parse', '--path-format=absolute', '--git-dir').trim() !== o.gitDirectory)
    fail('Worktree registration changed');
  const registrations = git(o.repository, 'worktree', 'list', '--porcelain', '-z').split('\0\0');
  const registration = registrations.find((record) => record.split('\0')[0] === `worktree ${o.worktree}`);
  if (!registration || registration.split('\0').some((field) => field === 'locked' || field.startsWith('locked ') || field.startsWith('prunable')))
    fail('Worktree is locked or registration is incomplete');
  for (const directory of [o.commonDirectory, o.gitDirectory]) {
    if (fs.readdirSync(directory).some((name) => name.endsWith('.lock') || name === 'locked')) fail('Git lock present');
  }
  if (exists(path.join(o.commonDirectory, 'refs/heads', o.branch + '.lock'))) fail('Branch lock present');
  if (git(o.worktree, 'symbolic-ref', '--short', 'HEAD').trim() !== o.branch || git(o.worktree, 'rev-parse', 'HEAD').trim() !== head)
    fail('Delivered head or branch changed');
  // Only uncommitted and unpushed changes block cleanup. Files Git ignores
  // (dependencies, build output, caches) are regenerable and removed with the
  // worktree. Hidden index flags would make modified tracked files invisible
  // to status, so they still fail closed.
  if (git(o.worktree, 'ls-files', '-v', '-z').split('\0').some((entry) => /^[a-zS]/.test(entry)))
    fail('Uncommitted changes may be hidden by assume-unchanged or skip-worktree index flags');
  if (git(o.worktree, 'status', '--porcelain=v1', '--untracked-files=all', '--ignored=no').length)
    fail('Uncommitted changes: modified, staged or untracked (not ignored) files');
  if (git(o.worktree, 'ls-files', '--stage', '-z').split('\0').some((entry) => entry.startsWith('160000 ')))
    fail('Submodule worktrees require manual retention');
  // Removing a linked worktree also destroys its private refs, reflogs and
  // in-progress state (merge, rebase, cherry-pick, bisect...), which are
  // uncommitted work. Leftover scratch files from finished operations are not:
  // COMMIT_EDITMSG (message draft), FETCH_HEAD (fetched objects stay in the
  // shared object store and on the remote), AUTO_MERGE (a tree, never a commit)
  // and REBASE_HEAD (its commit is checked for reachability below).
  const ordinaryState = new Set(['HEAD', 'index', 'commondir', 'gitdir', 'logs', 'ORIG_HEAD', 'COMMIT_EDITMSG', 'FETCH_HEAD', 'AUTO_MERGE', 'REBASE_HEAD', 'refs']);
  if (fs.readdirSync(o.gitDirectory).some((name) => !ordinaryState.has(name)))
    fail('Uncommitted in-progress Git operation or worktree-local state must be retained');
  // Git 2.52's files_ref_store_create_on_disk creates this compatibility
  // directory even for linked worktrees. Only an actually empty directory is
  // disposable; private refs, nested directories and unknown evidence retain it.
  const privateRefs = path.join(o.gitDirectory, 'refs');
  if (exists(privateRefs)) {
    physical(privateRefs);
    if (!fs.lstatSync(privateRefs).isDirectory() || fs.readdirSync(privateRefs).length)
      fail('Worktree-local refs or evidence must be retained');
  }
  const roots = new Set();
  for (const name of ['ORIG_HEAD', 'REBASE_HEAD']) {
    const pseudoRef = path.join(o.gitDirectory, name);
    if (!exists(pseudoRef)) continue;
    physical(pseudoRef);
    const oid = fs.readFileSync(pseudoRef, 'utf8').trim();
    if (!/^[0-9a-f]{40}$/.test(oid)) fail('Unrecognized ' + name + '; retain for inspection');
    if (!/^0+$/.test(oid)) roots.add(oid);
  }
  const logs = path.join(o.gitDirectory, 'logs');
  if (exists(logs)) {
    physical(logs);
    if (fs.readdirSync(logs).some((name) => name !== 'HEAD')) fail('Worktree-local reflogs must be retained');
    const headLog = path.join(logs, 'HEAD');
    if (exists(headLog)) {
      physical(headLog);
      for (const line of fs.readFileSync(headLog, 'utf8').split('\n').filter(Boolean)) {
        const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) /.exec(line);
        if (!match) fail('Unrecognized worktree reflog; retain for inspection');
        for (const oid of [match[1], match[2]]) if (!/^0+$/.test(oid)) roots.add(oid);
      }
    }
  }
  // These shared refs survive worktree removal. Do not rely on this or
  // another worktree's private HEAD/reflog as permanent recovery storage.
  const surviving = git(o.repository, 'for-each-ref', '--format=%(objectname)', 'refs/heads/', 'refs/tags/', 'refs/remotes/').trim().split('\n').filter(Boolean);
  const revisions = [...roots, ...surviving.map((oid) => '^' + oid)].join('\n') + '\n';
  if (roots.size && runGit(o.repository, ['rev-list', '--stdin'], revisions).trim())
    fail('Unpushed commits: worktree history has commits no surviving branch, tag or remote ref contains');
  // The worktree's project-scoped test database (packages/shared/src/testDbPort.ts)
  // would be orphaned by removal. Only containers labelled with this exact
  // Compose project AND this worktree's repo root are ever touched.
  const docker = Bun.which('docker');
  if (docker) {
    const project = 'tau-test-' + crypto.createHash('sha256').update(o.worktree).digest('hex').slice(0, 8);
    const recorded = exists(path.join(o.worktree, '.test-db-port'));
    // Name the project explicitly; never let Compose discover a file or project.
    const dockerEnv = { ...process.env };
    for (const key of Object.keys(dockerEnv)) if (key.startsWith('COMPOSE_')) delete dockerEnv[key];
    const listTestDb = () => {
      const listed = Bun.spawnSync([docker, 'ps', '-a', '--filter', 'label=com.docker.compose.project=' + project, '--format', '{{.Label "dev.ficus.test-db.repo-root"}}'], { env: dockerEnv, cwd: '/', stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 30000 });
      return listed.exitCode === 0 ? listed.stdout.toString().split('\n').filter((line) => line !== '') : null;
    };
    const running = listTestDb();
    if (!running && recorded)
      fail('Could not verify whether this worktree\'s test database (Compose project ' + project + ') is running; cleanup will retry');
    if (running && running.length) {
      if (running.some((root) => root !== o.worktree))
        fail('Compose project ' + project + ' is not labelled with this worktree; its containers were left untouched');
      const down = Bun.spawnSync([docker, 'compose', '-p', project, 'down', '--volumes'], { env: dockerEnv, cwd: '/', stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 120000 });
      const remaining = listTestDb();
      if (down.exitCode !== 0 || !remaining || remaining.length)
        fail('Could not stop this worktree\'s test database (Compose project ' + project + '); cleanup will retry');
    }
  }
  // All managed users remain fenced. Recheck the directory identity immediately
  // before the only destructive command. No force, prune, or branch deletion.
  physical(o.worktree);
  const finalIdentity = fs.lstatSync(o.worktree, { bigint: true });
  if (`${finalIdentity.dev}:${finalIdentity.ino}` !== o.directoryIdentity) fail('Worktree directory identity changed');
  removalStarted = true;
  git(o.repository, 'worktree', 'remove', '--', o.worktree);
  if (exists(o.worktree) || exists(o.gitDirectory)) fail('Removal left an owned residual; inspect before reuse');
  outcome = { status: 'succeeded', reason: 'Owned worktree removed; branch retained' };
} catch (error) {
  outcome = { status: removalStarted ? 'failed' : 'retained', reason: String(error.message).slice(0, 500) };
}
const result = { ...outcome, operationId, digest };
const fd = fs.openSync(receipt, 'wx', 0o600);
try { fs.writeFileSync(fd, JSON.stringify(result)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
const directoryFd = fs.openSync(active, 'r');
try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
console.log(JSON.stringify(result));
BUN_SCRIPT
