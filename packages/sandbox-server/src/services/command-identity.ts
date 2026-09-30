export interface ExecutorCommandIdentity {
  user: string
  home: string
  uid: number
  gid: number
  source: 'host' | 'image'
  contractDigest: string
}

export function readExecutorCommandIdentity(env: NodeJS.ProcessEnv): ExecutorCommandIdentity | undefined {
  if (env.EXECUTOR_DOCKER_RUNTIME !== '1') return undefined
  const user = env.EXECUTOR_COMMAND_USER
  const home = env.EXECUTOR_COMMAND_HOME
  const uid = Number(env.EXECUTOR_COMMAND_UID)
  const gid = Number(env.EXECUTOR_COMMAND_GID)
  const source = env.EXECUTOR_COMMAND_SOURCE === 'host' ? 'host' : 'image'
  const contractDigest = env.EXECUTOR_COMMAND_CONTRACT_DIGEST
  if (
    user !== 'tau' ||
    home !== '/home/tau' ||
    !Number.isSafeInteger(uid) ||
    !Number.isSafeInteger(gid) ||
    uid <= 0 ||
    gid <= 0 ||
    !contractDigest?.match(/^[a-f0-9]{64}$/)
  )
    throw new Error('Invalid Docker command identity configuration')
  return { user, home, uid, gid, source, contractDigest }
}

export function commandSpawn(identity: ExecutorCommandIdentity | undefined, command: string) {
  if (!identity) return { executable: 'bash', args: ['-c', command] }
  return { executable: 'su-exec', args: [identity.user, 'bash', '-c', command] }
}
