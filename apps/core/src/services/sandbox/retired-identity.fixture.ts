import type { DockerExecIdentity, SandboxIdentitySet } from './identity-names'

// Retired identities used only to prove canonical readers ignore them.
export const SANDBOX_IDENTITY_LEGACY: SandboxIdentitySet = {
  containerPrefix: 'tau-sandbox-', // ficus-p5-bridge
  managedLabel: 'tau.managed', // ficus-p5-bridge
  sandboxIdLabel: 'tau.sandbox-id', // ficus-p5-bridge
  specHashLabel: 'tau.spec-hash', // ficus-p5-bridge
  lifecycleGenerationLabel: 'tau.lifecycle-generation', // ficus-p5-bridge
  imageIdLabel: 'tau.image-id', // ficus-p5-bridge
  imageLabelNamespace: 'io.hiretau.sandbox', // ficus-p5-bridge
  k8sSpecHashAnnotation: 'tau.io/spec-hash', // ficus-p5-bridge
  k8sAppLabelValue: 'tau-sandbox', // ficus-p5-bridge
  k8sPodNamePrefix: 'tau-sb-', // ficus-p5-bridge
}

export const DOCKER_EXEC_IDENTITY_LEGACY: DockerExecIdentity = {
  user: 'tau', // ficus-p5-bridge
  home: '/home/tau', // ficus-p5-bridge
  executorTokenPath: '/run/tau/executor-token', // ficus-p5-bridge
  dockerProxySocketPath: '/run/tau-docker/docker.sock', // ficus-p5-bridge
}
