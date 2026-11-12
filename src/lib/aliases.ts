/**
 * Normalize a name for alias matching: lowercase, strip accents, spaces,
 * hyphens and punctuation. Hangul and other scripts are kept as-is.
 * "Ji hun" -> "jihun", "Jeong Ji-hoon" -> "jeongjihoon", "정지훈" -> "정지훈".
 */
export function normalizeAlias(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .normalize("NFC") // recompose Hangul so SQL literals like '정지훈' match
    .toLowerCase()
    .replace(/\s*\(.*?\)\s*/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
}
