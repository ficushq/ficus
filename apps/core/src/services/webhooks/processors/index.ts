/**
 * Webhook Processors Index
 *
 * Export all webhook processor implementations.
 */

export {
  githubProcessor,
  handleGithubPush,
  handleGithubPing,
  handleGithubManagedIndexing,
  setGithubActionConfig,
} from './github'

export { linearProcessor, handleLinearIssueUpdate, setLinearActionConfig } from './linear'
