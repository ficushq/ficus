import type { GitHubOAuthError } from '@ficus/shared/oauth-providers/github/client'

export interface GitHubAuthorizationFailure {
  status: 400 | 429 | 502 | 504
  code: string
  message: string
  retryAfterSeconds?: number
}

const UNREACHABLE = "GitHub couldn't be reached from this computer. Check the network connection and retry."
const REJECTED_CREDENTIALS = "GitHub rejected this app's client ID or secret."

/**
 * Translate a GitHub OAuth transport or provider error into a stable code and
 * a user-safe message. GitHub error bodies are never echoed; `code` is already
 * restricted to the client's allowlist or a local classification.
 */
export function describeGitHubAuthorizationError(error: GitHubOAuthError): GitHubAuthorizationFailure {
  switch (error.code) {
    case 'provider_unavailable':
    case 'request_aborted':
      return { status: 502, code: error.code, message: UNREACHABLE }
    case 'provider_timeout':
      return { status: 504, code: error.code, message: UNREACHABLE }
    case 'rate_limited':
      return {
        status: 429,
        code: error.code,
        message: 'GitHub is rate limiting requests from this computer. Wait a minute, then retry.',
        ...(error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
      }
    case 'device_flow_disabled':
      return {
        status: 400,
        code: error.code,
        message:
          "Device authorization is disabled for this GitHub App. Enable device flow in the app's settings or add a client secret.",
      }
    case 'incorrect_client_credentials':
    case 'invalid_auth':
      return { status: 400, code: error.code, message: REJECTED_CREDENTIALS }
    case 'capability_or_resource_denied':
      return {
        status: 502,
        code: error.code,
        message:
          "GitHub refused the request for this app. Check that the GitHub App's client ID is correct and the app still exists.",
      }
    case 'unverified_user_email':
      return {
        status: 400,
        code: error.code,
        message: 'Verify your primary email address on GitHub, then retry.',
      }
    case 'invalid_response':
    case 'response_too_large':
      return {
        status: 502,
        code: error.code,
        message: 'GitHub returned an unexpected response. Retry in a moment.',
      }
    default:
      return {
        status: 502,
        code: error.code,
        message: "GitHub couldn't complete the authorization request. Retry, or check the GitHub App's settings.",
      }
  }
}
