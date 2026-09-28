/** Demo mode (?demo, dev builds only): the sample farm, with no server behind it. */
export const isDemo = import.meta.env.DEV && new URLSearchParams(window.location.search).has('demo')
