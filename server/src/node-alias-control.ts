// C0/C1 controls plus Unicode's two dedicated line separators. The latter are
// not General_Category=Cc, but they still split log/source-prefix lines.
const CONTROL_CHARACTER = /[\p{Cc}\u2028\u2029]/u;

export function aliasControlCharacter(alias: string): string | null {
  return [...alias].find((char) => CONTROL_CHARACTER.test(char)) ?? null;
}

export function describeAliasControlCharacter(char: string): string {
  const codePoint = char.codePointAt(0) ?? 0;
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
}
