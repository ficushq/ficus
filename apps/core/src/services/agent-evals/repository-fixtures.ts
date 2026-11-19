import { FIXTURE_HEAD, type FixtureRepository } from './fixtures'

/** Declared fictional artifacts, kept small enough to inspect in a tool result. Not production code. */
export function assemblerRepository(memoryRegression = false): FixtureRepository {
  return {
    head: FIXTURE_HEAD,
    title: memoryRegression
      ? 'Extract squad prompt assembly (memory section regression)'
      : 'Extract shared squad prompt assembly',
    files: {
      'apps/core/src/lib/prompts/squad-agent-prompt.ts': [
        'export function assembleSquadWorkerPrompt({ memory }: { memory: { map?: string } | null }) {',
        memoryRegression
          ? '  if (memory?.map) return `## Memory System\n${memory.map}`;'
          : '  if (memory) return `## Memory System\n${memory.map ?? ""}`;',
        '  return "";',
        '}',
        'export function assembleSquadManagerPrompt(input: { memory: { map?: string } | null }) {',
        '  return assembleSquadWorkerPrompt(input);',
        '}',
      ].join('\n'),
      'apps/core/src/lib/prompts/squad-agent-prompt.test.ts': [
        'describe("memory section", () => {',
        '  test("keeps the section when map.md is missing", () => {',
        '    expect(assembleSquadWorkerPrompt({ memory: { map: undefined } })).toContain("## Memory System");',
        '  });',
        '});',
      ].join('\n'),
      'apps/core/src/entities/agent-runners/squad-worker-runner.ts':
        'import { assembleSquadWorkerPrompt } from "../../lib/prompts/squad-agent-prompt";\nconst prompt = assembleSquadWorkerPrompt({ memory });',
      'apps/core/src/entities/agent-runners/squad-manager-runner.ts':
        'import { assembleSquadManagerPrompt } from "../../lib/prompts/squad-agent-prompt";\nconst prompt = assembleSquadManagerPrompt({ memory });',
    },
  }
}
