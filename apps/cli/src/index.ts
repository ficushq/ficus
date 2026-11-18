import { defaultGitSigningDependencies, isSshKeygenInvocation, runSshKeygenCompat } from './git-signing'
import { createProgram } from './program'

// git runs `ficus` as its gpg.ssh.program (squad commit signing) with ssh-keygen's argv.
const args = process.argv.slice(2)
if (isSshKeygenInvocation(args)) {
  void runSshKeygenCompat(args, defaultGitSigningDependencies()).then((code) => {
    process.exitCode = code
  })
} else {
  createProgram().parse()
}
