import { describe, expect, it } from 'bun:test'
import {
  LOCAL_DEPLOYMENT_PROXY_ERROR_HEADER,
  LOCAL_DEPLOYMENT_PROXY_ERROR_MARKER_HEADERS,
  localDeploymentProxyJsonError,
  stripLocalDeploymentProxyErrorMarker,
} from './local-deployment-proxy-response'

describe('local deployment proxy error marker', () => {
  it("marks Core's own proxy errors with x-ficus-app-proxy: error", async () => {
    expect(LOCAL_DEPLOYMENT_PROXY_ERROR_HEADER).toBe('x-ficus-app-proxy')
    const response = localDeploymentProxyJsonError('Deployment not running', 404)
    expect(response.status).toBe(404)
    expect(response.headers.get('x-ficus-app-proxy')).toBe('error')
    expect(await response.json()).toEqual({ error: 'Deployment not running' })
  })

  it('strips the Ficus marker spelling only', () => {
    expect(LOCAL_DEPLOYMENT_PROXY_ERROR_MARKER_HEADERS).toEqual(['x-ficus-app-proxy'])
  })

  const appSuppliedMarkers = ['x-ficus-app-proxy']
  it.each(appSuppliedMarkers)('strips an app-supplied %s: error and keeps the app response', async (marker) => {
    const upstream = new Response('app-owned error', {
      status: 500,
      statusText: 'App Error',
      headers: { [marker]: 'error', 'content-type': 'text/plain' },
    })
    const response = stripLocalDeploymentProxyErrorMarker(upstream)
    expect(response.headers.get(marker)).toBeNull()
    expect(response.status).toBe(500)
    expect(response.statusText).toBe('App Error')
    expect(response.headers.get('content-type')).toBe('text/plain')
    expect(await response.text()).toBe('app-owned error')
  })
})
