/**
 * Test-only synthetic BigBrain install: an app-style `/bin/sh` shim at `~/.local/bin/bigbrain`
 * that execs Bun on a synthetic engine. The engine mimics the pinned upstream contract Ficus
 * relies on (bin/mcp.ts, lib/connectedClients.ts): `mcp config` creates or reuses ONE named
 * "cli:config" connection in the OS-HOME token store and prints its stdio entry; `mcp --client
 * <id>` serves the four public tools. It is not upstream code and holds no real credential.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { watch } from 'node:fs'
import { join } from 'node:path'

export type SyntheticMode =
  | 'ok'
  | 'revoked'
  | 'garbage'
  | 'sleep'
  | 'big'
  | 'wrong-vault'
  | 'fail'
  | 'spawn-child'
  | 'escaped-child'
  | 'escaped-child-ok'

export interface SyntheticBigbrain {
  root: string
  osHome: string
  executable: string
  observed: string
  setMode(mode: SyntheticMode): Promise<void>
  launches(): Promise<Array<Record<string, unknown>>>
  waitForLaunch(predicate: (entry: Record<string, unknown>) => boolean): Promise<void>
}

export async function createSyntheticBigbrain(root: string, osHome: string): Promise<SyntheticBigbrain> {
  const app = join(root, 'Big Brain.app', 'Contents')
  const macOS = join(app, 'MacOS')
  const engine = join(app, 'Resources', 'engine.ts')
  const bin = join(osHome, '.local', 'bin')
  const observed = join(root, 'observed.jsonl')
  const modeFile = join(root, 'mode')
  for (const dir of [macOS, join(engine, '..'), bin]) await mkdir(dir, { recursive: true, mode: 0o700 })
  await writeFile(join(macOS, 'bun'), `#!/bin/sh\nexec '${process.execPath}' "$@"\n`, { mode: 0o700 })
  await writeFile(modeFile, 'ok')
  await writeFile(
    engine,
    `
    import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
    import { createHash, randomBytes } from 'node:crypto';
    import { join } from 'node:path';
    import { spawn } from 'node:child_process';
    const args = process.argv.slice(2), mode = readFileSync(${JSON.stringify(modeFile)}, 'utf8').trim();
    const vault = process.env.BIGBRAIN_VAULT;
    appendFileSync(${JSON.stringify(observed)}, JSON.stringify({ args, cwd: process.cwd(), home: process.env.HOME, vault, tokens: process.env.BIGBRAIN_TOKENS, coreSecret: process.env.FICUS_TOKEN, homeDir: process.env.HOME_DIR, mode })+'\\n');
    if (args[0] === 'mcp' && args[1] === 'config') {
      if (mode === 'fail') { console.error('mcp: SECRET-STDERR-DETAIL /private/path'); process.exit(3); }
      if (mode === 'revoked') { console.error('Client connection was revoked. Reconnect in Connected Clients. SECRET-STDERR-DETAIL'); process.exit(1); }
      if (mode === 'garbage') { console.log('Authorization: Bearer SECRET-TOKEN not json'); process.exit(0); }
      if (mode === 'big') { process.stdout.write('x'.repeat(200000)); process.exit(0); }
      if (mode === 'sleep') { setTimeout(() => {}, 60000); }
      else if (mode === 'escaped-child' || mode === 'escaped-child-ok') {
        // A descendant in its own session (setsid) keeps stdout/stderr open after the group is killed.
        const escaped = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
        appendFileSync(${JSON.stringify(observed)}, JSON.stringify({ escapedPid: escaped.pid })+'\\n');
        if (mode === 'escaped-child') setTimeout(() => {}, 60000);
        else { console.log(JSON.stringify({ mcpServers: { bigbrain: { command: 'x', args: ['mcp', '--client', 'abcd1234'], env: { BIGBRAIN_VAULT: vault } } } })); process.exit(0); }
      }
      else if (mode === 'spawn-child') { spawn('sleep', ['30'], { stdio: 'inherit' }); setTimeout(() => {}, 60000); }
      else {
        const store = join(process.env.HOME, '.config', 'bigbrain', 'tokens', createHash('sha256').update(vault).digest('hex').slice(0, 12) + '.json');
        mkdirSync(store + '.clients', { recursive: true, mode: 0o700 });
        if (!existsSync(store)) writeFileSync(store, '{}', { mode: 0o600 });
        let id = readdirSync(store + '.clients').map(f => f.slice(0, 8)).find(i => JSON.parse(readFileSync(join(store + '.clients', i + '.json'), 'utf8')).managedBy === 'cli:config');
        if (!id) { id = randomBytes(4).toString('hex'); writeFileSync(join(store + '.clients', id + '.json'), JSON.stringify({ id, kind: 'generic', managedBy: 'cli:config', token: 'synthetic-not-a-secret' }), { mode: 0o600 }); appendFileSync(${JSON.stringify(observed)}, JSON.stringify({ minted: id })+'\\n'); }
        const entryVault = mode === 'wrong-vault' ? '/somewhere/else' : vault;
        console.log(JSON.stringify({ mcpServers: { bigbrain: { command: join(process.env.HOME, '.local', 'bin', 'bigbrain'), args: ['mcp', '--client', id], env: { BIGBRAIN_VAULT: entryVault } } } }, null, 2));
        process.exit(0);
      }
    } else if (args[0] === 'mcp' && args[1] === '--client') {
      if (mode === 'escaped-child' || mode === 'escaped-child-ok') {
        // Same escaped pipe holder for a session; '-ok' then exits the wrapper on its own.
        const escaped = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
        appendFileSync(${JSON.stringify(observed)}, JSON.stringify({ escapedPid: escaped.pid })+'\\n');
        if (mode === 'escaped-child-ok') process.exit(0);
      }
      let buffer=''; process.stdin.on('data', data => { buffer+=data; while(buffer.includes('\\n')) { const i=buffer.indexOf('\\n'), m=JSON.parse(buffer.slice(0,i)); buffer=buffer.slice(i+1); let result;
      if(m.method==='initialize') result={protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'synthetic',version:'1'}};
      if(m.method==='tools/list') result={tools:['load_memory','search_vault','read_note','drop'].map(name=>({name,inputSchema:{type:'object'}}))};
      if(m.method==='tools/call') { const name=m.params.name, a=m.params.arguments; const text=name==='load_memory' ? 'Synthetic working set' : JSON.stringify(name==='search_vault' ? {hits:[{path:'memory/MEMORY.md',title:'Synthetic'}]} : name==='read_note' ? {path:a.path,markdown:'Synthetic evidence'} : {queued:true,id:'synthetic-only'}); result={content:[{type:'text',text}]}; }
      if(m.id!==undefined) console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result})); }});
    } else { console.error('unknown'); process.exit(2); }
    `
  )
  const executable = join(bin, 'bigbrain')
  // Mirrors the pinned upstream app shim's quoting/exec contract, including spaces in paths.
  await writeFile(
    executable,
    `#!/bin/sh\n# installed by BigBrain.app\nexec '${join(macOS, 'bun')}' '${engine}' "$@"\n`,
    {
      mode: 0o700,
    }
  )
  const fixture: SyntheticBigbrain = {
    root,
    osHome,
    executable,
    observed,
    setMode: (mode) => writeFile(modeFile, mode),
    waitForLaunch(predicate) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error('Synthetic child never became ready')), 10_000)
        const watcher = watch(root, () => {
          void check()
        })
        let finished = false
        function finish(error?: Error) {
          if (finished) return
          finished = true
          clearTimeout(timer)
          watcher.close()
          if (error) reject(error)
          else resolve()
        }
        async function check() {
          try {
            if ((await fixture.launches()).some(predicate)) finish()
          } catch (error) {
            finish(error as Error)
          }
        }
        void check()
      })
    },
    async launches() {
      try {
        return (await readFile(observed, 'utf8'))
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      } catch {
        return []
      }
    },
  }
  return fixture
}

/** A BigBrain vault: a directory with a regular vault.yaml. */
export async function createSyntheticVault(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await writeFile(join(path, 'vault.yaml'), 'name: synthetic\n')
  return path
}
