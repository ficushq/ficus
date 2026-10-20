import { expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db, integrationConnections, settings, squads } from '../../../db'
import { IntegrationConnectionService } from '../connection-service'
import { DbIntegrationConnectionRepository } from '../db-connection-repository'
import { IntegrationRuntimeGate } from '../runtime-gate'
import { INTEGRATION_ENABLED_PREFIX, setIntegrationEnabled } from '../provider-state'
import { BigbrainBindings } from './local-bindings'
import { BigbrainLocalConnections } from './local-connections'
import { BigbrainProvider } from './provider'
import { createBigbrainTools } from './tools'

// Exercises real discovery, persistence, validation, assignment, gates and owned stdio.
// A synthetic app-style shell shim is NOT a packaged macOS end-to-end test.
test('Desktop host setup and all four tools work with OS HOME separate from Ficus HOME_DIR', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bigbrain-desktop-')))
  const previousEnv = { ...process.env }
  const key = INTEGRATION_ENABLED_PREFIX + 'bigbrain'
  const [previousSetting] = await db.select().from(settings).where(eq(settings.key, key))
  const [squad] = await db.insert(squads).values({ name: 'Synthetic Desktop BigBrain', purpose: 'test' }).returning()
  let connectionId: string | undefined
  try {
    const home = join(root, 'Ficus Home'),
      osHome = join(root, 'Users', 'Synthetic Mac'),
      vault = join(root, 'vault')
    const macOS = join(root, 'BigBrain.app', 'Contents', 'MacOS'),
      engine = join(root, 'BigBrain.app', 'Contents', 'Resources', 'engine.ts')
    const bin = join(osHome, '.local', 'bin'),
      store = join(
        osHome,
        '.config',
        'bigbrain',
        'tokens',
        createHash('sha256').update(vault).digest('hex').slice(0, 12) + '.json'
      )
    for (const dir of [home, vault, macOS, join(engine, '..'), bin, `${store}.clients`])
      await mkdir(dir, { recursive: true, mode: 0o700 })
    await writeFile(join(vault, 'vault.yaml'), 'name: synthetic\n')
    await writeFile(store, '{}', { mode: 0o600 })
    await writeFile(join(`${store}.clients`, 'aabb0011.json'), '{}', { mode: 0o600 })
    await symlink(process.execPath, join(macOS, 'bun'))
    const observed = join(root, 'observed.jsonl')
    await writeFile(
      engine,
      `
      import { appendFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(observed)}, JSON.stringify({ args: process.argv.slice(2), home: process.env.HOME, vault: process.env.BIGBRAIN_VAULT, tokens: process.env.BIGBRAIN_TOKENS, coreSecret: process.env.FICUS_TOKEN, homeDir: process.env.HOME_DIR })+'\\n');
      let buffer=''; process.stdin.on('data', data => { buffer+=data; while(buffer.includes('\\n')) { const i=buffer.indexOf('\\n'), m=JSON.parse(buffer.slice(0,i)); buffer=buffer.slice(i+1); let result;
      if(m.method==='initialize') result={protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'synthetic',version:'1'}};
      if(m.method==='tools/list') result={tools:['load_memory','search_vault','read_note','drop'].map(name=>({name,inputSchema:{type:'object'}}))};
      if(m.method==='tools/call') { const name=m.params.name, args=m.params.arguments; const text=name==='load_memory' ? 'Synthetic working set' : JSON.stringify(name==='search_vault' ? {hits:[{path:'memory/MEMORY.md',title:'Synthetic'}]} : name==='read_note' ? {path:args.path,markdown:'Synthetic evidence'} : {queued:true,id:'synthetic-only'}); result={content:[{type:'text',text}]}; }
      if(m.id!==undefined) console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result})); }});
    `
    )
    const executable = join(bin, 'bigbrain')
    // Matches the pinned upstream app shim's quoting/exec contract, including spaces.
    await writeFile(executable, `#!/bin/sh\nexec '${join(macOS, 'bun')}' '${engine}' "$@"\n`, { mode: 0o700 })
    Object.assign(process.env, {
      HOME: osHome,
      HOME_DIR: home,
      FICUS_SANDBOX_RUNTIME: 'host',
      FICUS_DESKTOP_MANAGED: '1',
      FICUS_TOKEN: 'must-not-forward',
      BIGBRAIN_TOKENS: '/must-not-inherit',
    })
    delete process.env.FICUS_MANAGED
    const bindings = new BigbrainBindings()
    const repository = new DbIntegrationConnectionRepository()
    const material = new Map<string, string>()
    const credentials = {
      get: (ref: string) => material.get(ref),
      set: async (ref: string, value: string) => {
        material.set(ref, value)
      },
      delete: async (ref: string) => {
        material.delete(ref)
      },
    }
    const service = new IntegrationConnectionService({
      repository,
      assignments: repository,
      credentials,
      resolveProvider: () => new BigbrainProvider(),
    })
    const local = new BigbrainLocalConnections(bindings, service)
    expect(await local.list()).toEqual({ state: 'setup_required', bindings: [] })
    // Supported-but-unconfigured can enable; no declaration is installed automatically.
    await setIntegrationEnabled('bigbrain', true, 'test')
    await writeFile(
      join(home, 'bigbrain-bindings.json'),
      JSON.stringify({
        version: 1,
        bindings: [
          { id: 'personal', label: 'Synthetic', vaultPath: vault, executablePath: executable, clientId: 'aabb0011' },
        ],
      }),
      { mode: 0o600 }
    )
    expect((await local.list()).state).toBe('available')
    const created = await local.create({ bindingId: 'personal', displayName: 'Synthetic' }, 'test')
    connectionId = created.id
    expect(created).toMatchObject({ enabled: false, authState: 'authenticated', lastErrorCode: null })
    expect(await service.enable(created.id)).toMatchObject({ enabled: true })
    await repository.assign(squad.id, 'bigbrain', created.id)
    const gate = new IntegrationRuntimeGate({
      repository,
      currentAuthority: () => 'local',
      supportedAdapterVersion: () => 2,
      supportedConfigVersion: () => 2,
    })
    const tools = createBigbrainTools({
      agent: {
        id: 'synthetic-agent',
        squadId: squad.id,
        integrationCapabilities: { version: 1, allow: { bigbrain: ['agent_tools'] } },
      },
      squadId: squad.id,
      gate,
      credentials,
      connections: repository,
      audit: { record: async () => {} },
    })
    const inputs = [
      {},
      { query: 'synthetic' },
      { path: 'memory/MEMORY.md' },
      { title: 'Synthetic finding', body: 'Not a real vault write' },
    ]
    for (const [index, tool] of tools.entries()) {
      const result = await tool.execute(
        'synthetic-call',
        inputs[index],
        undefined,
        undefined as never,
        undefined as never
      )
      expect(result.details).toMatchObject({
        provider: 'bigbrain',
        connectionId: created.id,
        result: expect.anything(),
      })
    }
    const launches = (await readFile(observed, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(launches).toHaveLength(6) // validation, enable's validation, four explicit tools
    for (const launch of launches)
      expect(launch).toEqual({ args: ['mcp', '--client', 'aabb0011'], home: osHome, vault })
    await chmod(store, 0o644)
    expect((await local.list()).state).toBe('invalid_configuration')
    await chmod(store, 0o600)
    await rm(executable)
    expect((await local.list()).state).toBe('binding_unavailable')
    process.env.FICUS_MANAGED = '1'
    expect(
      (
        await gate.check({
          agent: {
            id: 'agent',
            squadId: squad.id,
            integrationCapabilities: { version: 1, allow: { bigbrain: ['agent_tools'] } },
          },
          squadId: squad.id,
          provider: 'bigbrain',
          capability: 'agent_tools',
        })
      ).allowed
    ).toBe(false)
  } finally {
    process.env = previousEnv
    await db.delete(squads).where(eq(squads.id, squad.id))
    if (connectionId) await db.delete(integrationConnections).where(eq(integrationConnections.id, connectionId))
    if (previousSetting) await db.update(settings).set(previousSetting).where(eq(settings.key, key))
    else await db.delete(settings).where(eq(settings.key, key))
    await rm(root, { recursive: true, force: true })
  }
}, 30000) // Six intentionally short-lived processes each include a 1s process-group reap grace.
