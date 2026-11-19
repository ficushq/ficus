/** Produces the same lowercase, hyphen-separated ids accepted by NewProfileDialog. No collision overwrites. */
export function profileIdFromName(name: string): string {
  const id =
    name
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 100)
      .replace(/-+$/g, '') || 'from-github'
  return id === 'default' ? 'default-voice' : id
}
