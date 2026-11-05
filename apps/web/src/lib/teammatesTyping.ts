/** What a screen reader hears: "Alice is typing", "Alice and Bob are typing", "Alice, Bob and 2 others are typing". */
export function typingSummary(names: string[]): string {
  if (names.length === 0) return ''
  if (names.length === 1) return `${names[0]} is typing`
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing`
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]} are typing`
  return `${names[0]}, ${names[1]} and ${names.length - 2} others are typing`
}
