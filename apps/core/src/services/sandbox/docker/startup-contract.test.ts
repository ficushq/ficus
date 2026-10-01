import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..')
const startupPath = resolve(repoRoot, 'apps/core/docker-sandbox/startup.sh')
const shutdownPath = resolve(repoRoot, 'apps/core/docker-sandbox/shutdown.sh')
const startup = readFileSync(startupPath, 'utf8')
const shutdown = readFileSync(shutdownPath, 'utf8')

describe('Docker startup contract', () => {
  test('uses a private token and permission-scoped raw Docker forwarder', () => {
    expect(startup).toContain('/run/ficus/executor-token')
    expect(startup).toContain('/run/ficus-docker/docker.sock')
    expect(startup).toContain('umask 077')
    expect(startup).toContain('mode=0600')
    expect(startup).toContain('-m 0711')
    expect(startup).not.toMatch(/chmod\s+666/)
    expect(startup).not.toMatch(/\/proc\/.*environ|Config\.Env/)
  })
  test('fails closed on identity collisions and reports the resolved source', () => {
    expect(startup).toContain('requested command identity collides with the image')
    expect(startup).toContain('EXECUTOR_COMMAND_SOURCE="$IDENTITY_SOURCE"')
    expect(startup).not.toContain('usermod -o')
    expect(startup).toContain('test -w /home/ficus')
    expect(startup).toContain('.ficus-runtime-write-$$')
    expect(startup).toContain('awk -F: \'$1 == "ficus" { print $6 }\'')
  })
  test('supervises both executor and proxy children', () => {
    expect(startup).toContain('EXECUTOR_PID=$!')
    expect(startup).toContain('PROXY_PID=$!')
    expect(startup).toContain('/run/ficus/proxy.pid')
    expect(startup).toContain('/run/ficus/executor.pid')
    expect(startup).toContain('trap cleanup EXIT INT TERM')
    expect(startup).toContain('supervise_child proxy')
    expect(startup).toContain('supervise_child executor')
    // Probe-responsiveness guards: the server must outrank saturated workloads
    // (nice) and outlive memory pressure (oom_score_adj) — losing either
    // re-opens the healthy-box-condemned-under-load recreate loop.
    expect(startup).toMatch(/FICUS_CHILD_OOM_ADJ=-500 supervise_child executor .* nice -n -10 bun run/)
    expect(startup).toContain('oom_score_adj')
    expect(startup).toContain('IFS= read -r FAILED_CHILD <"$CHILD_EXIT_FIFO"')
    expect(startup).toContain('. /usr/local/lib/ficus-shutdown.sh')
    expect(shutdown).toContain('kill -KILL "$pid"')
    expect(shutdown).toContain('if [ "$state" = Z ]')
  })

  test('launches the ficus-browser service as a fail-open second process (dev parity)', () => {
    // One container = one box = one context: the shared-per-machine browser
    // service runs here as a plain background process. It is NOT a gate —
    // musl-Chromium is documented-fragile, so a failure must never take down the
    // box server (|| ... non-fatal), and the launch is backgrounded (&).
    expect(startup).toContain('/opt/ficus/browser/service/ficus-browser.js')
    expect(startup).toContain('FICUS_BROWSER_SOCK')
    expect(startup).toContain('/run/ficus-browser/sock')
    expect(startup).toContain('FICUS_BROWSER_MEMORY_HIGH_MB')
    // Fail-open: the service launch is guarded so it can never abort startup.
    expect(startup).toMatch(/start_browser_service \|\|/)
    // Seed the tokens dir with sha256(token) (R-B8 digest auth) so the same auth
    // path the VM machines use works in-container.
    expect(startup).toContain('sha256sum')
    expect(startup).toMatch(/browser-tokens/)
    // Never downgrade the Chromium sandbox from a startup launch.
    expect(startup).not.toMatch(/no-sandbox/)
  })

  test('runs the browser unprivileged while preserving the executor authentication identity', () => {
    expect(startup).toContain(
      'exec su-exec ficus env HOME=/home/ficus FICUS_BROWSER_TOKENS_DIR="$tokens_dir" bun "$service"'
    )
    expect(startup).toContain('chown ficus:ficus "$tokens_dir" "$tokens_dir/${FICUS_BROWSER_DEV_ALLOW_USER}.token"')
    expect(startup).toContain('cd /opt/ficus/browser || exit 1')
  })

  test('R-B17: seeds the digest at the proxy-sent user and exports FICUS_BROWSER_DEV_ALLOW_USER', () => {
    // The box server is not su-exec'd, so browser-proxy sends
    // x-ficus-box-user:<this script's OS user>. The service's prod box_<hex> gate
    // would 401 it, so FICUS_BROWSER_DEV_ALLOW_USER (prod NEVER sets it) admits
    // exactly that user — and the digest MUST be seeded under that same user, not
    // the (differing) command user, or auth still fails.
    expect(startup).toContain('FICUS_BROWSER_DEV_ALLOW_USER')
    // Exported so BOTH the main server (browser-proxy) and the browser service
    // inherit it; derived from the OS user this script runs as.
    expect(startup).toMatch(/export FICUS_BROWSER_DEV_ALLOW_USER=.*id -un/)
    // The token file is keyed by the dev-allow user, matching the proxy header —
    // NOT the hardcoded command user.
    expect(startup).toContain('${FICUS_BROWSER_DEV_ALLOW_USER}.token')
    expect(startup).not.toContain('${EXECUTOR_COMMAND_USER}.token')
    // The export precedes the box server launch so the main server inherits it.
    expect(startup.indexOf('export FICUS_BROWSER_DEV_ALLOW_USER')).toBeLessThan(
      startup.indexOf('supervise_child executor')
    )
  })

  afterEach(() => {
    // Belt-and-braces reaper: the perl code string is unique to this fixture,
    // so any survivor here is ours. pkill's no-match exit is fine.
    Bun.spawnSync(['pkill', '-9', '-f', 'SIG{TERM}="IGNORE"'])
  })

  // NARROW, EVIDENCE-BASED SKIP — Linux behaviour stays fully enforced.
  //
  // stop_and_join() decides liveness by polling /proc/<pid>/stat. Darwin has no
  // /proc, so `[ ! -e "/proc/$pid/stat" ]` is true on the first iteration and
  // the function immediately `wait`s on a child that ignores TERM by design —
  // blocking until the fixture's outer `timeout 10` fires. Measured on macOS:
  // this test failed at 10021 ms, with `/proc/<pid>/stat` confirmed absent.
  //
  // shutdown.sh ships INSIDE the Docker sandbox image and only ever runs on
  // Linux, so the script is not wrong; the test is not portable. Making the
  // script portable would add a branch that nothing in production exercises.
  // The companion assertion below keeps this reason from going stale: if the
  // liveness check stops being /proc-based, it fails and this skip should go.
  const skipOnDarwin = process.platform === 'darwin'
  if (skipOnDarwin) {
    console.log(
      '[startup-contract] Skipping the TERM-resistant cleanup test on darwin: ' +
        'shutdown.sh polls /proc/<pid>/stat, which does not exist here, so stop_and_join blocks in `wait`. ' +
        'Linux CI runs it unmodified.'
    )
  }
  test.skipIf(skipOnDarwin)(
    'a TERM-resistant child cannot hang final cleanup',
    () => {
      // The traps make the fixture self-cleaning: the perl child ignores TERM by
      // DESIGN (that is what the test exercises), so if this sh dies early — the
      // outer `timeout` firing, a signal, any failure path — the busy-loop child
      // must be KILLed on the way out or it survives forever (27 orphans once
      // pinned a dev machine at load ~130).
      const fixture = `ready=$(mktemp); . "$1"; perl -e '$SIG{TERM}="IGNORE"; open my $f, ">", $ARGV[0]; print $f "ready"; close $f; 1 while 1' "$ready" & pid=$!; trap 'kill -9 "$pid" 2>/dev/null' EXIT; trap 'kill -9 "$pid" 2>/dev/null; exit 143' TERM INT; while [ ! -s "$ready" ]; do sleep 0.01; done; stop_and_join "$pid"; status=0; kill -0 "$pid" 2>/dev/null && status=1; rm -f "$ready"; exit "$status"`
      const result = Bun.spawnSync(['timeout', '10', 'sh', '-c', fixture, 'shutdown-fixture', shutdownPath], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(result.exitCode).toBe(0)
    },
    12_000
  )

  test('the Darwin skip above is still justified by a /proc-based liveness check', () => {
    // Runs on every platform. If stop_and_join is ever made portable, this
    // fails and the skip has to be removed rather than quietly outliving its
    // reason — which is how a narrow skip turns into a broad one.
    expect(shutdown).toContain('/proc/$pid/stat')
  })
})
