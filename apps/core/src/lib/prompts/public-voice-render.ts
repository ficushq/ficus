/*
 * The generated public voice section's token and fallback. No database access, so the prompt
 * assembler (squad-agent-prompt.ts) and the agent behaviour evals stay database-free;
 * public-voice-prompt.ts loads and renders the live voice.
 */

/** Template token for the generated voice section, on the last line of the `public-text` include. */
export const PUBLIC_VOICE_PROMPT_TOKEN = '{{squad.publicVoice}}'

/**
 * The section to append when a composed type prompt lacks the token (a custom
 * type, or an overridden include list), so the agent still reads the voice
 * exactly once. Nothing when the `public-text` rules are disabled.
 */
export function publicVoicePromptFallback(typePrompt: string, section: string, publicTextEnabled: boolean): string {
  return section && publicTextEnabled && !typePrompt.includes(PUBLIC_VOICE_PROMPT_TOKEN) ? section : ''
}
