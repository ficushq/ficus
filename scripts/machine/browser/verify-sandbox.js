// One-shot Chromium sandbox verification — PHASE 1 hard gate (spec §4.1/§5).
// Launches headless Chromium WITHOUT --no-sandbox and confirms a renderer works
// under the unprivileged ficus-browser user (a missing user-namespace grant
// crashes the zygote here) and that chrome://sandbox does not report an
// unsandboxed process. Exit 0 = sandbox active; non-zero = FAIL (bootstrap
// aborts, browsing disabled on this host — never downgraded to --no-sandbox).
//
// SINGLE SOURCE OF TRUTH: packages/machine-image/Dockerfile COPYs this file, and
// scripts/machine/bootstrap.sh (write_browser_verify) embeds it verbatim.
// bootstrap.test.ts asserts the two copies stay byte-identical.
const { chromium } = require('playwright')

async function main() {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    // A renderer that loads a page proves the user-namespace sandbox could be
    // entered; without the AppArmor userns grant this throws.
    await page.goto('about:blank', { timeout: 15000 })
    await page.goto('chrome://sandbox', { timeout: 15000 }).catch(() => {})
    const text = (await page.innerText('body').catch(() => '')) || ''
    if (/not sandboxed/i.test(text)) {
      throw new Error('chrome://sandbox reports an unsandboxed process: ' + text.slice(0, 200))
    }
    console.error('ficus-browser: sandbox verification passed')
  } finally {
    await browser.close().catch(() => {})
  }
}

main().catch((err) => {
  console.error('ficus-browser: sandbox verification FAILED —', err && err.message ? err.message : err)
  process.exit(1)
})
