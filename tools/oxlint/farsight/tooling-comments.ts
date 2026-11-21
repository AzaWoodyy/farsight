const TOOLING =
  /^\s*(?:(?:oxlint|eslint)-(?:disable|enable)\b|@ts-(?:expect-error|ignore|nocheck|check)\b|SAFETY:|turbopackIgnore:|webpack[A-Z]\w*:|\/\s*<reference\s)/u;

export function isToolingComment(value: string): boolean {
  return TOOLING.test(value);
}
