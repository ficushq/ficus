export function setQueryParamInPath(path: string, param: string, value: string | null | undefined): string {
  const url = new URL(path, 'http://ficus.local')
  if (value === null || value === undefined) {
    url.searchParams.delete(param)
  } else {
    url.searchParams.set(param, value)
  }

  const search = url.searchParams.toString()
  return `${url.pathname}${search ? `?${search}` : ''}${url.hash}`
}
