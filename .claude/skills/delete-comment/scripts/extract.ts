import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseSync } from "oxc-parser";

import { isToolingComment } from "../../../../tools/oxlint/farsight/tooling-comments.ts";

export type Extracted = {
  id: number;
  file: string;
  start: number;
  end: number;
  line: number;
  endLine: number;
  text: string;
  hash: string;
  jsx: { start: number; end: number } | null;
};

type Span = { start: number; end: number };

const SLICE_SIZE = 200;

function trackedSources(paths: readonly string[]): string[] {
  const listed = execFileSync("git", ["ls-files", "--", ...paths], { encoding: "utf8" });
  return listed
    .split("\n")
    .filter((file) => /\.tsx?$/u.test(file))
    .filter((file) => !file.startsWith("tools/oxlint/anti-slop/"));
}

function hasVisibleText(node: { type?: string; value?: string } | undefined): boolean {
  return node?.type === "JSXText" && (node.value ?? "").trim() !== "";
}

function emptyJsxExpressions(node: object, found: Span[] = []): Span[] {
  for (const value of Object.values(node)) {
    if (value === null || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      value.forEach((child, at) => {
        const empty =
          child?.type === "JSXExpressionContainer" &&
          child.expression?.type === "JSXEmptyExpression";
        const betweenText = hasVisibleText(value[at - 1]) && hasVisibleText(value[at + 1]);
        if (empty && !betweenText) found.push({ start: child.start, end: child.end });
      });
    }
    emptyJsxExpressions(value, found);
  }
  return found;
}

function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) if (source[index] === "\n") line += 1;
  return line;
}

export function commentsOf(file: string): Omit<Extracted, "id">[] {
  const source = readFileSync(file, "utf8");
  const hash = createHash("sha256").update(source).digest("hex");
  const parsed = parseSync(file, source);
  const containers = emptyJsxExpressions(parsed.program);
  const alone = (span: Span, text: string) => source.slice(span.start + 1, span.end - 1).trim() === text;
  return parsed.comments
    .filter((comment) => !isToolingComment(comment.value))
    .map((comment) => ({
      hash,
      jsx:
        containers.find(
          (span) =>
            span.start <= comment.start &&
            comment.end <= span.end &&
            alone(span, source.slice(comment.start, comment.end)),
        ) ?? null,
      file,
      start: comment.start,
      end: comment.end,
      line: lineOf(source, comment.start),
      endLine: lineOf(source, comment.end - 1),
      text: source.slice(comment.start, comment.end),
    }));
}

function main(): void {
  const [outDir, ...paths] = process.argv.slice(2);
  if (outDir === undefined) throw new Error("usage: extract.ts <out-dir> [path…]");
  if (existsSync(join(outDir, "comments.json"))) {
    throw new Error(`${outDir} already holds an extraction: use a new directory`);
  }
  const scope = paths.length > 0 ? paths : ["."];
  const comments: Extracted[] = trackedSources(scope)
    .flatMap(commentsOf)
    .map((comment, id) => ({ id, ...comment }));
  mkdirSync(join(outDir, "slices"), { recursive: true });
  mkdirSync(join(outDir, "out"), { recursive: true });
  writeFileSync(join(outDir, "comments.json"), JSON.stringify(comments));

  const slices: Extracted[][] = [];
  let current: Extracted[] = [];
  let previous = "";
  for (const comment of comments) {
    if (comment.file !== previous && current.length >= SLICE_SIZE) {
      slices.push(current);
      current = [];
    }
    current.push(comment);
    previous = comment.file;
  }
  if (current.length > 0) slices.push(current);

  slices.forEach((slice, index) => {
    const name = String(index + 1).padStart(2, "0");
    let text = "";
    let file = "";
    for (const comment of slice) {
      if (comment.file !== file) text += `\n## ${comment.file}\n`;
      file = comment.file;
      text += `\n[${comment.id}] L${comment.line}\n${comment.text}\n`;
    }
    writeFileSync(join(outDir, "slices", `${name}.md`), text);
  });

  const lines = comments.reduce((sum, comment) => sum + comment.endLine - comment.line + 1, 0);
  console.log(
    `${comments.length} comments on ${lines} lines in ${new Set(comments.map((comment) => comment.file)).size} files, ${slices.length} slices in ${outDir}`,
  );
}

if (import.meta.main) main();
