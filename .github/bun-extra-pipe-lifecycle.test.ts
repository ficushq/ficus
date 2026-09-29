import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Playwright's browser transport uses stdio[3] and stdio[4]. Bun 1.3.8
// handed those descriptors to Node sockets but also closed them from the
// Subprocess finalizer, after the kernel had reused them for unrelated files.
// Bun 1.4.2 get_stdio marks these extra pipes UnownedFd after exposing them.
// Isolate the reproducer: a broken runtime must not corrupt this test runner.
test('collected extra-pipe subprocesses leave newly opened files intact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ficus-extra-pipe-regression-'))
  let child: ReturnType<typeof Bun.spawn> | undefined
  try {
    const script = join(dir, 'probe.mjs')
    await writeFile(
      script,
      `import { openSync, closeSync, fstatSync, writeSync, readSync } from 'node:fs';
import assert from 'node:assert/strict';
import { join } from 'node:path';
async function exerciseExtraPipes() {
  const child = Bun.spawn([process.execPath, '--no-install', '-e',
    "require('node:fs').writeSync(3, 'three'); require('node:fs').writeSync(4, 'four')"],
    { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  // Reading stdio transfers these descriptors to the caller. Node's
  // child_process wrapper does this when constructing its extra sockets.
  const pipes = child.stdio.slice(3);
  try {
    assert.equal(await child.exited, 0);
    for (const [index, expected] of ['three', 'four'].entries()) {
      const buffer = Buffer.alloc(expected.length);
      assert.equal(readSync(pipes[index], buffer), expected.length);
      assert.equal(buffer.toString(), expected);
    }
    return { oldChild: new WeakRef(child), closedDescriptors: pipes };
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
    for (const fd of pipes) closeSync(fd);
  }
}
const { oldChild, closedDescriptors } = await exerciseExtraPipes();
const held = [];
try {
  for (let i = 0; i < 64; i++) held.push(openSync(join(import.meta.dirname, 'neighbor-' + i), 'w'));
  assert.ok(closedDescriptors.every(fd => held.includes(fd)), 'reuse both extra-pipe descriptor numbers');
  // Explicitly run native finalizers after descriptor reuse. Separate JS
  // turns let the completed child's temporary references leave the stack.
  for (let i = 0; i < 3; i++) {
    await new Promise(resolve => setImmediate(resolve));
    Bun.gc(true);
  }
  assert.equal(oldChild.deref(), undefined, 'the old child must actually be collected');
  for (const fd of held) {
    writeSync(fd, 'still owned');
    assert.equal(fstatSync(fd).size, 11);
  }
  console.log('64 neighboring descriptors remained valid');
} finally {
  for (const fd of held) { try { closeSync(fd); } catch {} }
}
`
    )
    child = Bun.spawn([process.execPath, '--no-install', script], {
      cwd: dir,
      env: { PATH: process.env.PATH, TMPDIR: tmpdir() },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 8000,
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
    expect(stdout.trim()).toBe('64 neighboring descriptors remained valid')
  } finally {
    if (child && child.exitCode === null) child.kill()
    await child?.exited
    await rm(dir, { recursive: true, force: true })
  }
}, 10_000)
