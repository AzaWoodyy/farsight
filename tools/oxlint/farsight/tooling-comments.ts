const TOOLING =
  /^\s*(?:(?:(?:oxlint|eslint)-(?:disable(?:-next-line|-line)?|enable)|@ts-(?:expect-error|ignore|nocheck|check))(?=[\s:]|$)|SAFETY:|turbopackIgnore:|webpack[A-Z]\w*:|\/\s*<reference\s)/u;

export function isToolingComment(value: string): boolean {
  return TOOLING.test(value);
}
