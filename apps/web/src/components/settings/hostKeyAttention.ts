import type { RemoteHost } from '../../api/remote-hosts'

/** Whether a host needs a person's attention on its host key (shown without expanding the row). */
export function hostKeyNeedsAttention(host: Pick<RemoteHost, 'hostKeyState'>): boolean {
  return host.hostKeyState === 'pending' || host.hostKeyState === 'changed' || host.hostKeyState === 'unverified'
}
