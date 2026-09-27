/**
 * PWA Icon Generator Script
 *
 * This script generates PNG icons from an SVG source for PWA support.
 * It creates icons in various sizes required for different platforms.
 *
 * Usage: bun run scripts/generate-icons.ts
 *
 * Prerequisites:
 *   - Install sharp: bun add -D sharp @types/sharp
 *   - Ensure source SVG exists at public/icons/icon-source.svg
 */

import sharp from 'sharp'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'

const ICONS_DIR = join(__dirname, '../public/icons')

// Icon sizes for PWA manifest
const STANDARD_SIZES = [72, 96, 128, 144, 152, 192, 384, 512]
const MASKABLE_SIZES = [192, 512]
const SHORTCUT_SIZE = 96

// Ficus logo SVG - blue gradient with tau symbol
const LOGO_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#3b82f6;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#1d4ed8;stop-opacity:1" />
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="76" fill="url(#grad)"/>
  <text x="256" y="340" 
        font-family="system-ui, -apple-system, sans-serif" 
        font-size="280" 
        font-weight="bold" 
        fill="white" 
        text-anchor="middle">τ</text>
</svg>
`

// Maskable icon SVG (with extra padding for safe area)
const MASKABLE_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#3b82f6;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#1d4ed8;stop-opacity:1" />
    </linearGradient>
  </defs>
  <rect width="512" height="512" fill="url(#grad)"/>
  <text x="256" y="320" 
        font-family="system-ui, -apple-system, sans-serif" 
        font-size="200" 
        font-weight="bold" 
        fill="white" 
        text-anchor="middle">τ</text>
</svg>
`

// Tasks shortcut icon
const TASKS_SHORTCUT_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">
  <rect width="96" height="96" rx="12" fill="#2563eb"/>
  <path d="M28 32h40M28 48h40M28 64h40" 
        stroke="white" stroke-width="4" stroke-linecap="round"/>
  <circle cx="22" cy="32" r="4" fill="white"/>
  <circle cx="22" cy="48" r="4" fill="white"/>
  <circle cx="22" cy="64" r="4" fill="white"/>
</svg>
`

// Chat shortcut icon
const CHAT_SHORTCUT_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">
  <rect width="96" height="96" rx="12" fill="#2563eb"/>
  <path d="M24 30 h48 a4 4 0 0 1 4 4 v28 a4 4 0 0 1 -4 4 h-28 l-12 12 v-12 h-8 a4 4 0 0 1 -4 -4 v-28 a4 4 0 0 1 4 -4" 
        fill="none" stroke="white" stroke-width="4"/>
  <circle cx="36" cy="48" r="4" fill="white"/>
  <circle cx="48" cy="48" r="4" fill="white"/>
  <circle cx="60" cy="48" r="4" fill="white"/>
</svg>
`

async function generateIcon(svgContent: string, size: number, outputPath: string): Promise<void> {
  const buffer = Buffer.from(svgContent)

  await sharp(buffer).resize(size, size).png().toFile(outputPath)

  console.log(`Generated: ${outputPath}`)
}

async function main(): Promise<void> {
  // Ensure icons directory exists
  await mkdir(ICONS_DIR, { recursive: true })

  // Save source SVG
  await writeFile(join(ICONS_DIR, 'icon-source.svg'), LOGO_SVG.trim())
  console.log('Saved: icon-source.svg')

  // Generate standard icons
  for (const size of STANDARD_SIZES) {
    await generateIcon(LOGO_SVG, size, join(ICONS_DIR, `icon-${size}x${size}.png`))
  }

  // Generate maskable icons
  for (const size of MASKABLE_SIZES) {
    await generateIcon(MASKABLE_SVG, size, join(ICONS_DIR, `icon-maskable-${size}x${size}.png`))
  }

  // Generate shortcut icons
  await generateIcon(TASKS_SHORTCUT_SVG, SHORTCUT_SIZE, join(ICONS_DIR, 'shortcut-tasks.png'))

  await generateIcon(CHAT_SHORTCUT_SVG, SHORTCUT_SIZE, join(ICONS_DIR, 'shortcut-chat.png'))

  // Generate Apple touch icon (180x180)
  await generateIcon(LOGO_SVG, 180, join(ICONS_DIR, 'apple-touch-icon.png'))

  // Generate favicon (32x32)
  await generateIcon(LOGO_SVG, 32, join(ICONS_DIR, 'favicon-32x32.png'))

  // Generate favicon (16x16)
  await generateIcon(LOGO_SVG, 16, join(ICONS_DIR, 'favicon-16x16.png'))

  console.log('\nAll icons generated successfully!')
  console.log('To regenerate, run: bun run scripts/generate-icons.ts')
}

main().catch(console.error)
