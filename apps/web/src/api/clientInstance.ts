import { createClient } from '@ficus/client-core'
import { webTransport } from './transport'

/** Singleton Ficus API client bound to the web (cookie) transport. */
export const client = createClient(webTransport)
