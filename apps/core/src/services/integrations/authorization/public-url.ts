import { resolvePublicAppUrl } from '../../../lib/public-app-url'

const CALLBACK_PATH = '/settings/integrations/oauth/callback'

export function resolveIntegrationOAuthCallbackUrl(providerKey = 'notion'): string {
  const url = new URL(resolveOAuthCallbackUrl())
  if (providerKey === 'github') url.pathname += '/github'
  return url.toString()
}
const hasControlCharacter = (value: string) =>
  [...value].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)

export function resolveOAuthCallbackUrl(
  appUrl: string | undefined = resolvePublicAppUrl(),
  appBasePath: string | undefined = process.env.APP_BASE_PATH
): string {
  if (!appUrl || appUrl.includes('\\')) throw invalidPublicUrl()
  let url: URL
  try {
    url = new URL(appUrl)
  } catch {
    throw invalidPublicUrl()
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    containsEncodedControl(url.pathname)
  ) {
    throw invalidPublicUrl()
  }

  const urlBasePath = normalizePath(url.pathname, 'Invalid public application URL')
  const basePath = urlBasePath || normalizePath(appBasePath ?? '', 'Invalid application base path')
  url.pathname = `${basePath}${CALLBACK_PATH}`
  return url.toString()
}

function normalizePath(input: string, message: string): string {
  const value = input.trim()
  if (!value || value === '/') return ''
  if (
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    value.includes('?') ||
    value.includes('#') ||
    containsEncodedControl(value)
  ) {
    throw new Error(message)
  }
  return `/${value.replace(/^\/+|\/+$/g, '')}`
}

function containsEncodedControl(value: string): boolean {
  try {
    return hasControlCharacter(decodeURIComponent(value))
  } catch {
    return true
  }
}

function invalidPublicUrl(): Error {
  return new Error('Invalid public application URL')
}
