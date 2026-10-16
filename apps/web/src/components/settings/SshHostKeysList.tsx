import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  decideSshHostKey,
  listMachineSshHostKeys,
  listSquadSshHostKeys,
  scanSshHostKeys,
  type SshTrustTarget,
} from '../../api/ssh-host-keys'
import { HostKeysPanel } from './HostKeysPanel'

interface ListProps {
  targets: SshTrustTarget[]
  canAct: boolean
  onChanged: () => void
}

/** One host-key panel per endpoint (fetch, and Trust / Reject for pending keys). */
export function SshHostKeysList({ targets, canAct, onChanged }: ListProps) {
  if (!targets.length) return null
  return (
    <ul className="space-y-3" data-testid="ssh-host-keys">
      {targets.map((target) => (
        <li key={target.id} className="ficus-inset p-3 space-y-1">
          <div className="text-sm font-medium text-primary">
            {target.label}{' '}
            <span className="text-xs text-muted font-mono">
              {target.sshHost}:{target.sshPort}
            </span>
          </div>
          <HostKeysPanel
            host={target}
            canAct={canAct}
            scan={() => scanSshHostKeys(target.id)}
            decide={(keyId, decision) => decideSshHostKey(target.id, keyId, decision)}
            onChanged={onChanged}
          />
        </li>
      ))}
    </ul>
  )
}

/** Host keys of the machines and exe.dev that Ficus connects to (Settings > Machines). */
export function MachineSshHostKeys({ canAct }: { canAct: boolean }) {
  const queryClient = useQueryClient()
  const queryKey = ['ssh-host-keys', 'machines']
  const { data = [] } = useQuery({ queryKey, queryFn: listMachineSshHostKeys })
  if (!data.length) return null
  return (
    <div>
      <h4 className="text-sm font-semibold text-primary">SSH host keys</h4>
      <p className="text-xs text-muted mt-1 mb-2">
        Ficus connects to a machine only when its host key matches one a person trusted here. Compare each fingerprint
        with the one on the machine itself before trusting it.
      </p>
      <SshHostKeysList targets={data} canAct={canAct} onChanged={() => queryClient.invalidateQueries({ queryKey })} />
    </div>
  )
}

/** Host keys of a squad's memory git remotes (Memory settings). */
export function MemorySyncSshHostKeys({ squadId, canAct }: { squadId: string; canAct: boolean }) {
  const queryClient = useQueryClient()
  const queryKey = ['ssh-host-keys', 'squad', squadId]
  const { data = [] } = useQuery({ queryKey, queryFn: () => listSquadSshHostKeys(squadId) })
  if (!data.length) return null
  return (
    <div className="mb-4">
      <h4 className="text-xs font-medium text-primary">Git host key</h4>
      <p className="text-xs text-muted mt-1 mb-2">
        Memory sync connects only when the git server&apos;s host key matches one a person trusted here.
      </p>
      <SshHostKeysList targets={data} canAct={canAct} onChanged={() => queryClient.invalidateQueries({ queryKey })} />
    </div>
  )
}
