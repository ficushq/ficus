import type { DockerExecIdentity, SandboxIdentitySet } from './identity-names'

// Retired identities used only to prove canonical readers ignore them.
export const SANDBOX_IDENTITY_LEGACY: SandboxIdentitySet = {
  containerPrefix: 'foreign-sandbox-',
  managedLabel: 'foreign.managed',
  sandboxIdLabel: 'foreign.sandbox-id',
  specHashLabel: 'foreign.spec-hash',
  lifecycleGenerationLabel: 'foreign.lifecycle-generation',
  imageIdLabel: 'foreign.image-id',
  imageLabelNamespace: 'io.example.sandbox',
  k8sSpecHashAnnotation: 'foreign.io/spec-hash',
  k8sAppLabelValue: 'foreign-sandbox',
  k8sPodNamePrefix: 'foreign-sb-',
}

export const DOCKER_EXEC_IDENTITY_LEGACY: DockerExecIdentity = {
  user: 'foreign',
  home: '/home/foreign',
  executorTokenPath: '/run/foreign/executor-token',
  dockerProxySocketPath: '/run/foreign-docker/docker.sock',
}
