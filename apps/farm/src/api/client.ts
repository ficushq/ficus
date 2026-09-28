import { createClient } from '@ficus/client-core'
import { createFarmTransport } from './transport'

export const client = createClient(createFarmTransport())
export type FarmClient = typeof client
