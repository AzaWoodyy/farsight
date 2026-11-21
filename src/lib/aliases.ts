export function normalizeAlias(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/\s*\(.*?\)\s*/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
}
