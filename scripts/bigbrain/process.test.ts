import { expect, test } from 'bun:test'
import { runPrivateCommand, vaultCommand } from './process'

test('bounded private command has no inherited credentials and consumes owned stdin/output', async () => {
  const before = process.env.FICUS_SYNTHETIC_PROCESS_SECRET
  process.env.FICUS_SYNTHETIC_PROCESS_SECRET = 'PRIVATE'
  try {
    const result = await runPrivateCommand(
      [
        process.execPath,
        '-e',
        'process.stdout.write(JSON.stringify({ secret: process.env.FICUS_SYNTHETIC_PROCESS_SECRET ?? null, input: await Bun.stdin.text(), home: process.env.HOME }))',
      ],
      { input: 'synthetic' }
    )
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ secret: null, input: 'synthetic', home: '/nonexistent' })
  } finally {
    if (before === undefined) delete process.env.FICUS_SYNTHETIC_PROCESS_SECRET
    else process.env.FICUS_SYNTHETIC_PROCESS_SECRET = before
  }
})
test('oversized stdout/stderr, failing commands and spawn errors never reflect content', async () => {
  for (const stream of ['stdout', 'stderr'])
    await expect(
      runPrivateCommand([
        process.execPath,
        '-e',
        `process.${stream}.write('PRIVATE'.repeat(10000)); await Bun.sleep(60000)`,
      ])
    ).rejects.toThrow('output_limit')
  expect(await runPrivateCommand([process.execPath, '-e', "console.log('PRIVATE'); process.exit(2)"])).toEqual({
    code: 2,
    stdout: '',
  })
  await expect(runPrivateCommand(['/this-does-not-exist-714'])).rejects.toThrow('operation_failed')
})
test('deadline kills and awaits the owned child; invalid budgets/input never spawn', async () => {
  await expect(
    runPrivateCommand([process.execPath, '-e', 'await Bun.sleep(60000)'], { timeoutMs: 1000 })
  ).rejects.toThrow('operation_failed')
  for (const options of [{ input: 'x'.repeat(8193) }, { timeoutMs: 1 }, { timeoutMs: 45001 }])
    await expect(runPrivateCommand([process.execPath, '-e', "throw new Error('PRIVATE')"], options)).rejects.toThrow(
      'invalid_request'
    )
})
test('vault CLI drops supplementary groups, capabilities and future privilege before the fixed binary', () => {
  const binary = `/opt/ficus-bigbrain/releases/${'a'.repeat(64)}/bigbrain-shared`
  const args = vaultCommand({ uid: 1200, gid: 1201 }, binary, ['member', 'list', '--json'])
  expect(args).toEqual([
    '/usr/bin/setpriv',
    '--reuid=1200',
    '--regid=1201',
    '--clear-groups',
    '--no-new-privs',
    '--inh-caps=-all',
    '--ambient-caps=-all',
    '--bounding-set=-all',
    '--pdeathsig=KILL',
    '/usr/bin/env',
    '-i',
    'HOME=/nonexistent',
    'PATH=/usr/bin:/bin',
    'LANG=C.UTF-8',
    binary,
    'member',
    'list',
    '--json',
  ])
  expect(() => vaultCommand({ uid: 0, gid: 1201 }, binary, [])).toThrow('invalid_request')
  expect(() => vaultCommand({ uid: 1200, gid: 1201 }, '/usr/bin/bash', [])).toThrow('invalid_request')
})
