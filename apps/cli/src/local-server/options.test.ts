import { describe, expect, it } from 'bun:test'
import { resolveSetupOptions, SetupOptionsError, type Prompter } from './options'

const noPrompt: Prompter = {
  select: async () => {
    throw new Error('select should not be called')
  },
  confirm: async () => true,
}

describe('resolveSetupOptions', () => {
  it('resolves supervisor flag over env over persisted value over the OS default', async () => {
    const flagged = await resolveSetupOptions(
      { runtime: 'host', supervisor: 'pm2' },
      { FICUS_SETUP_SUPERVISOR: 'systemd-user' },
      noPrompt,
      false,
      { supervisor: 'launchd' },
      'linux'
    )
    expect(flagged.supervisor).toBe('pm2')
    expect(flagged.explicit.has('supervisor')).toBe(true)

    const fromEnv = await resolveSetupOptions(
      { runtime: 'host' },
      { FICUS_SETUP_SUPERVISOR: 'systemd-user' },
      noPrompt,
      false,
      { supervisor: 'pm2' },
      'linux'
    )
    expect(fromEnv.supervisor).toBe('systemd-user')
    expect(
      (await resolveSetupOptions({ runtime: 'host' }, {}, noPrompt, false, { supervisor: 'pm2' }, 'linux')).supervisor
    ).toBe('pm2')
    expect((await resolveSetupOptions({ runtime: 'host' }, {}, noPrompt, false, {}, 'darwin')).supervisor).toBe(
      'launchd'
    )
    expect((await resolveSetupOptions({ runtime: 'host' }, {}, noPrompt, false, {}, 'linux')).supervisor).toBe(
      'systemd-user'
    )
  })

  it('rejects unknown and platform-incompatible supervisors', async () => {
    await expect(
      resolveSetupOptions({ runtime: 'host', supervisor: 'launchd' }, {}, noPrompt, false, {}, 'linux')
    ).rejects.toThrow(/launchd.*macOS/i)
    await expect(
      resolveSetupOptions({ runtime: 'host', supervisor: 'systemd-user' }, {}, noPrompt, false, {}, 'darwin')
    ).rejects.toThrow(/systemd-user.*Linux/i)
    await expect(
      resolveSetupOptions({ runtime: 'host', supervisor: 'bogus' }, {}, noPrompt, false, {}, 'linux')
    ).rejects.toThrow(/Unknown supervisor/i)
    await expect(
      resolveSetupOptions({ runtime: 'host', supervisor: 'pm2' }, {}, noPrompt, false, {}, 'darwin')
    ).resolves.toMatchObject({ supervisor: 'pm2' })
  })

  it('uses flags over env over defaults', async () => {
    const opts = await resolveSetupOptions(
      { runtime: 'host', port: '4000' },
      { FICUS_SETUP_RUNTIME: 'docker-socket', FICUS_SETUP_PORT: '5000', FICUS_SETUP_DB_NAME: 'tau2' },
      noPrompt,
      false
    )
    expect(opts.runtime).toBe('host')
    expect(opts.port).toBe(4000)
    expect(opts.dbName).toBe('tau2')
    expect(opts.explicit.has('runtime')).toBe(true)
    expect(opts.explicit.has('port')).toBe(true)
    expect(opts.explicit.has('dbName')).toBe(true)
    expect(opts.explicit.has('appUrl')).toBe(false)
  })
  it('rejects a --db-name that is not a safe PostgreSQL identifier', async () => {
    await expect(resolveSetupOptions({ runtime: 'host', dbName: 'My-DB' }, {}, noPrompt, false)).rejects.toThrow(
      /--db-name must match .* \(got "My-DB"\)/
    )
    await expect(
      resolveSetupOptions({ runtime: 'host', dbName: 'my_db2' }, {}, noPrompt, false)
    ).resolves.toMatchObject({ dbName: 'my_db2' })
  })
  it('derives api/app urls from the port', async () => {
    const opts = await resolveSetupOptions({ runtime: 'host', port: '3100' }, {}, noPrompt, false)
    expect(opts.apiUrl).toBe('http://localhost:3100')
    expect(opts.appUrl).toBe('http://localhost:3100')
    expect(opts.databaseUrl).toBe('postgres://postgres:postgres@localhost:5432/tau')
    expect(opts.databaseMode).toBe('compose')
  })
  it('accepts an external database url and disables compose', async () => {
    const opts = await resolveSetupOptions(
      { runtime: 'host', databaseUrl: 'postgres://u:p@db.example:5432/x' },
      {},
      noPrompt,
      false
    )
    expect(opts.databaseMode).toBe('external')
    expect(opts.databaseUrl).toBe('postgres://u:p@db.example:5432/x')
  })
  it('rejects an app url with a path', async () => {
    await expect(
      resolveSetupOptions({ runtime: 'host', appUrl: 'http://localhost:3000/tau' }, {}, noPrompt, false)
    ).rejects.toThrow(/bare origin/)
  })
  it('exits 2 without a tty when runtime is missing', async () => {
    const err = await resolveSetupOptions({}, {}, noPrompt, false).catch((e) => e)
    expect(err).toBeInstanceOf(SetupOptionsError)
    expect((err as SetupOptionsError).exitCode).toBe(2)
    expect((err as SetupOptionsError).message).toContain('--runtime')
  })
  it('points k8s and vm at the chooser doc with exit 2', async () => {
    const err = await resolveSetupOptions({ runtime: 'vm' }, {}, noPrompt, false).catch((e) => e)
    expect((err as SetupOptionsError).exitCode).toBe(2)
    expect((err as SetupOptionsError).message).toContain('docs/wiki/sandbox-runtimes.md')
  })
  it('prompts for the runtime on a tty even with --yes', async () => {
    const seen: string[] = []
    const prompter: Prompter = {
      select: async (question, choices) => {
        seen.push(question)
        return choices[1].value
      },
      confirm: async () => true,
    }
    const opts = await resolveSetupOptions({ yes: true }, {}, prompter, true)
    expect(seen.length).toBe(1)
    expect(opts.runtime).toBe('docker-socket')
  })
  it('defaults the instance to tau and takes the label from the flag over the env', async () => {
    const bare = await resolveSetupOptions({ runtime: 'host' }, {}, noPrompt, false)
    expect(bare.instance).toBe('tau')
    expect(bare.explicit.has('instance')).toBe(false)
    expect(bare.dbPort).toBeUndefined()
    expect(bare.makeDefault).toBe(false)

    const opts = await resolveSetupOptions(
      { runtime: 'host', instance: 'Smoke' },
      { FICUS_SETUP_INSTANCE: 'other' },
      noPrompt,
      false
    )
    expect(opts.instance).toBe('smoke')
    expect(opts.explicit.has('instance')).toBe(true)
  })
  it('takes the instance from the env when there is no flag', async () => {
    const opts = await resolveSetupOptions({ runtime: 'host' }, { FICUS_SETUP_INSTANCE: 'ci2' }, noPrompt, false)
    expect(opts.instance).toBe('ci2')
    expect(opts.explicit.has('instance')).toBe(true)
  })
  it('rejects an invalid instance label with exit 2', async () => {
    const err = await resolveSetupOptions({ runtime: 'host', instance: 'bad label' }, {}, noPrompt, false).catch(
      (e) => e
    )
    expect(err).toBeInstanceOf(SetupOptionsError)
    expect((err as SetupOptionsError).exitCode).toBe(2)
    expect((err as SetupOptionsError).message).toContain('bad label')
  })
  it('takes the db port from the flag over the env and puts it in the compose database url', async () => {
    const opts = await resolveSetupOptions(
      { runtime: 'host', dbPort: '5433' },
      { FICUS_SETUP_DB_PORT: '5599' },
      noPrompt,
      false
    )
    expect(opts.dbPort).toBe(5433)
    expect(opts.explicit.has('dbPort')).toBe(true)
    expect(opts.databaseUrl).toBe('postgres://postgres:postgres@localhost:5433/tau')

    const fromEnv = await resolveSetupOptions({ runtime: 'host' }, { FICUS_SETUP_DB_PORT: '5599' }, noPrompt, false)
    expect(fromEnv.dbPort).toBe(5599)
    expect(fromEnv.explicit.has('dbPort')).toBe(true)
  })
  it('rejects a non-numeric db port', async () => {
    await expect(resolveSetupOptions({ runtime: 'host', dbPort: 'abc' }, {}, noPrompt, false)).rejects.toThrow(
      /--db-port/
    )
  })
  it('records --default', async () => {
    const opts = await resolveSetupOptions({ runtime: 'host', default: true }, {}, noPrompt, false)
    expect(opts.makeDefault).toBe(true)
  })
  it('falls back to the checkout persisted instance and port, which flags and env still beat', async () => {
    const persisted = { instance: 'smoke', port: 3100 }
    const kept = await resolveSetupOptions({ runtime: 'host' }, {}, noPrompt, false, persisted)
    expect(kept.instance).toBe('smoke')
    expect(kept.port).toBe(3100)
    expect(kept.apiUrl).toBe('http://localhost:3100')
    // Persisted values are already in .env: writing them back must not be forced.
    expect(kept.explicit.has('instance')).toBe(false)
    expect(kept.explicit.has('port')).toBe(false)

    const overridden = await resolveSetupOptions(
      { runtime: 'host', instance: 'other', port: '3200' },
      {},
      noPrompt,
      false,
      persisted
    )
    expect(overridden.instance).toBe('other')
    expect(overridden.port).toBe(3200)
    expect(overridden.explicit.has('instance')).toBe(true)

    const fromEnv = await resolveSetupOptions(
      { runtime: 'host' },
      { FICUS_SETUP_INSTANCE: 'ci2', FICUS_SETUP_PORT: '3300' },
      noPrompt,
      false,
      persisted
    )
    expect(fromEnv.instance).toBe('ci2')
    expect(fromEnv.port).toBe(3300)
  })
  it('rejects a port whose derived worker ports would not fit', async () => {
    await expect(resolveSetupOptions({ runtime: 'host', port: '65533' }, {}, noPrompt, false)).rejects.toThrow(/--port/)
    const highest = await resolveSetupOptions({ runtime: 'host', port: '65532' }, {}, noPrompt, false)
    expect(highest.port).toBe(65532)
  })
  it('rejects a non-numeric port', async () => {
    await expect(resolveSetupOptions({ runtime: 'host', port: 'abc' }, {}, noPrompt, false)).rejects.toThrow(/port/)
  })
})
