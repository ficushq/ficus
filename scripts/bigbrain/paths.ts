import { isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'

export const BIGBRAIN_STATE_ROOT = '/var/lib/ficus-bigbrain'
const pathInput = z
  .object({
    vaultId: z
      .string()
      .uuid()
      .regex(/^[0-9a-f-]{36}$/),
    // Only fixture/operator injection; never taken from a helper/API request.
    root: z
      .string()
      .refine((v) => isAbsolute(v) && resolve(v) === v && v !== '/')
      .optional(),
  })
  .strict()

export function managedPaths(input: { vaultId: string; root?: string }) {
  const parsed = pathInput.safeParse(input)
  if (!parsed.success) throw new Error('invalid_request')
  const { vaultId } = parsed.data
  const root = parsed.data.root ?? BIGBRAIN_STATE_ROOT
  const mount = join(root, 'vaults', vaultId)
  const control = join(root, 'control', vaultId)
  return {
    root,
    mount,
    control,
    image: join(root, 'volumes', `${vaultId}.img`),
    vault: join(mount, 'vault'),
    memberStore: join(mount, 'auth', 'members.json'),
    receipt: join(control, 'receipt.json'),
    ownerEscrow: join(control, 'owner.json'),
    invitations: join(control, 'invitations'),
    handoff: join(root, 'read-handoff', `${vaultId}.json`),
    unit: `ficus-bigbrain@${vaultId}.service`,
  }
}
