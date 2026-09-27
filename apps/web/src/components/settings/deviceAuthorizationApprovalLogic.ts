export function devicePlatformLabel(platform: string): string {
  if (platform === 'ios') return 'iOS'
  if (platform === 'android') return 'Android'
  if (platform === 'cli') return 'Ficus CLI'
  if (platform === 'desktop') return 'Ficus Desktop'
  return 'Device'
}

export function parseDeviceRequest(hash: string): string {
  const match = hash.match(/(?:^#|&)device_request=([^&]+)/)
  if (!match) return ''
  try {
    return decodeURIComponent(match[1])
  } catch {
    return ''
  }
}

export async function approveDeviceRequest(input: {
  verificationCode: string
  approve: (input: { verificationCode: string }) => Promise<unknown>
  clearFragment: () => void
}): Promise<void> {
  await input.approve({ verificationCode: input.verificationCode })
  input.clearFragment()
}

export function deviceApprovalErrorMessage(_error: unknown, platform?: string): string {
  const retry =
    platform === 'desktop' ? 'Start again from Ficus Desktop.' : 'Run ficus auth login again to create a new request.'
  return `Approval failed because this request is expired or already used. ${retry}`
}
