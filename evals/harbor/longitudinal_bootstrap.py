"""Isolated fixture overlay; production bootstrap and native role prompts stay unchanged."""

FOLLOWUP = """} else if (command === 'follow-up') {
  const identity = JSON.parse(await readFile(`${root}/identity.json`, 'utf8'))
  const request = JSON.parse(await readFile(`${root}/next-request.json`, 'utf8'))
  if (!Number.isInteger(request.round) || request.round < 2 || request.round > 3 || typeof request.instruction !== 'string') {
    throw new Error('Invalid longitudinal request')
  }
  const squad = await Squad.mustFind(identity.squadId)
  if (squad.managerAgentId !== identity.managerId) throw new Error('Manager identity changed')
  const manager = await Agent.mustFind(identity.managerId)
  await manager.sendMessage(request.instruction, { metadata: { source: 'harbor-longitudinal', round: request.round } })
  await writeFile(output, JSON.stringify({ squadId: squad.id, managerId: manager.id, round: request.round }))
} else if (command === 'memory-export') {
  const documents = await db.select().from(memoryDocuments)
  const chunks = await db.select().from(memoryChunks)
  await writeFile(output, JSON.stringify({ documents, chunks }))
"""


def render(source):
    replacements = [
        (
            "  workStreamWaits,\n",
            "  workStreamWaits,\n  memoryDocuments,\n  memoryChunks,\n",
        ),
        ("memory: { enabled: false }", "memory: { enabled: true }"),
        (
            "} else if (command === 'snapshot') {",
            FOLLOWUP + "} else if (command === 'snapshot') {",
        ),
    ]
    for old, new in replacements:
        if source.count(old) != 1:
            raise ValueError("Unexpected isolated bootstrap; refusing overlay")
        source = source.replace(old, new)
    return source
