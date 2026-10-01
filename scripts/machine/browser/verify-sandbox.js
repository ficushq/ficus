// One-shot Linux Chromium sandbox gate. Missing or unreadable diagnostics are
// failures; a working renderer alone does not prove Chromium enabled isolation.
// Bootstrap leaves browsing unavailable when this program fails.
//
// SINGLE SOURCE OF TRUTH: the image COPYs this file and bootstrap.sh embeds it
// verbatim. Both launchers use the service's exact pinned launch options.
import { CHROMIUM_LAUNCH_OPTIONS } from './ficus-browser.js'

export function assertSandboxStatus(text) {
  // Chromium's sandboxGood requires a layer-one namespace sandbox (including
  // PID and network namespaces) plus the layer-two seccomp-BPF sandbox.
  if (!/(?:^|\n)Layer 1 Sandbox\s+Namespace(?:\s|$)/i.test(text)) {
    throw new Error('Chromium sandbox status did not confirm the namespace sandbox')
  }
  for (const label of ['PID namespaces', 'Network namespaces', 'Seccomp-BPF sandbox']) {
    if (!new RegExp(`(?:^|\\n)${label}\\s+Yes(?:\\s|$)`, 'i').test(text)) {
      throw new Error(`Chromium sandbox status did not confirm ${label}`)
    }
  }
  if (!/(?:^|\n)You are adequately sandboxed\.(?:\s|$)/i.test(text)) {
    throw new Error('Chromium did not report adequate sandboxing')
  }
}

export async function verifySandbox(chromium) {
  const browser = await chromium.launch(CHROMIUM_LAUNCH_OPTIONS)
  try {
    const page = await browser.newPage()
    await page.goto('chrome://sandbox', { timeout: 15000 })
    const text = await page.innerText('body', { timeout: 15000 })
    assertSandboxStatus(text)
  } finally {
    await browser.close()
  }
}

if (import.meta.main) {
  try {
    const { chromium } = await import('playwright')
    await verifySandbox(chromium)
    console.error('ficus-browser: sandbox verification passed (namespace, PID, network, seccomp-BPF)')
  } catch (err) {
    console.error('ficus-browser: sandbox verification FAILED —', err && err.message ? err.message : err)
    process.exitCode = 1
  }
}
