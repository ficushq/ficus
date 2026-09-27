import { createClient } from '@ficus/client-core'
import { createGardenTransport } from './transport'

export const client = createClient(createGardenTransport())
export type GardenClient = typeof client
