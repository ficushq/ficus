/** The marker Core sets on its own proxy errors; the control plane reads it. */
export const LOCAL_DEPLOYMENT_PROXY_ERROR_HEADER = 'x-ficus-app-proxy'
/** Headers an app response is cleared of, so an app can never forge Core's marker. */
export const LOCAL_DEPLOYMENT_PROXY_ERROR_MARKER_HEADERS = ['x-ficus-app-proxy'] as const

export function localDeploymentProxyError(body: BodyInit, status: number, headers?: HeadersInit): Response {
  const markedHeaders = new Headers(headers)
  markedHeaders.set(LOCAL_DEPLOYMENT_PROXY_ERROR_HEADER, 'error')
  return new Response(body, { status, headers: markedHeaders })
}

export function localDeploymentProxyJsonError(error: string, status: number): Response {
  return localDeploymentProxyError(JSON.stringify({ error }), status, { 'content-type': 'application/json' })
}

/** Never let an app forge the internal Core-to-Platform error marker. */
export function stripLocalDeploymentProxyErrorMarker(response: Response): Response {
  const headers = new Headers(response.headers)
  for (const name of LOCAL_DEPLOYMENT_PROXY_ERROR_MARKER_HEADERS) headers.delete(name)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
