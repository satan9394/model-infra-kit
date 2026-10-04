/** FTS markers carry text, never HTML. React escapes each returned text segment. */
export function snippetParts(snippet: string): { text: string; highlighted: boolean }[] {
  const parts: { text: string; highlighted: boolean }[] = []
  let highlighted = false
  for (const text of snippet.split(/([\u0001\u0002])/)) {
    if (text === "\u0001") highlighted = true
    else if (text === "\u0002") highlighted = false
    else if (text) parts.push({ text, highlighted })
  }
  return parts
}
