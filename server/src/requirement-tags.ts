/** Small, network-local labels; count Unicode code points rather than UTF-16 units. */
export function normalizeTags(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 10) return null;
  const tags: string[] = [];
  for (const valueTag of value) {
    if (typeof valueTag !== "string") return null;
    const tag = valueTag.trim();
    if (!tag || [...tag].length > 20 || /[\u0000-\u001f\u007f]/u.test(tag)) return null;
    if (!tags.includes(tag)) tags.push(tag);
  }
  return tags;
}

export function storedTags(value: string | null): string[] {
  try { return normalizeTags(JSON.parse(value || "[]")) ?? []; } catch { return []; }
}
