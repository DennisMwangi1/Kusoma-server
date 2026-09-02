/**
 * Brace-aware JSON object extraction. Unlike /\{[^}]*\}/, this respects nested
 * objects and braces inside strings.
 */
export function extractBalancedJsonFrom(text: string, start: number): string | null {
  if (start < 0 || start >= text.length || text[start] !== "{") return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (c === "\\") {
        escape = true;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Last complete JSON object whose first (or any leading) property is `key`.
 * Matches `{ "key": ... }` including nested values and braces inside strings.
 */
export function extractJsonObjectWithKey(
  text: string,
  key: string,
): { raw: string; start: number } | null {
  const re = new RegExp(`\\{\\s*"${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:`, "g");
  let start = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) start = m.index;
  if (start < 0) return null;
  const raw = extractBalancedJsonFrom(text, start);
  if (!raw) return null;
  return { raw, start };
}
