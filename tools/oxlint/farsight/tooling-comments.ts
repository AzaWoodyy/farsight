const TOOLING =
  /^\s*(?:oxlint-|eslint-|@ts-|SAFETY:|turbopackIgnore:|webpack[A-Z]\w*:|\/\s*<reference\s)/u;

export function isToolingComment(value: string): boolean {
  return TOOLING.test(value);
}
