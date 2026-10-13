/** The dashboard search box accepts literal text; the API still supports FTS syntax. */
export function literalSearchQuery(query: string): string {
  return `"${query.replaceAll("\u0000", "").trim().slice(0, 2046).replaceAll('"', '""')}"`
}

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
