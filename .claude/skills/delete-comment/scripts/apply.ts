import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Extracted } from "./extract.ts";

type Item = { id: number; cat: string };

const DELETED = new Set(["T", "S", "E", "D"]);

function isBlank(line: string | undefined): boolean {
  return line !== undefined && line.trim() === "";
}

function opensBlock(line: string | undefined): boolean {
  return line === undefined || /[{([]$/u.test(line.trimEnd());
}

function closesBlock(line: string | undefined): boolean {
  return line === undefined || /^[)\]}]/u.test(line.trimStart());
}

function strip(source: string, comments: readonly Extracted[]): string {
  const MARK = "\u0000";
  let text = source;
  for (const comment of [...comments].sort((a, b) => b.start - a.start)) {
    if (text.slice(comment.start, comment.end) !== comment.text) {
      throw new Error(`${comment.file}:${comment.line} moved since the extraction; extract again`);
    }
    let start = comment.start;
    let end = comment.end;
    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    const newline = text.indexOf("\n", end);
    const lineEnd = newline === -1 ? text.length : newline;
    let before = text.slice(lineStart, start);
    let after = text.slice(end, lineEnd);
    if (before.trimEnd().endsWith("{") && after.trimStart().startsWith("}")) {
      const open = lineStart + before.lastIndexOf("{");
      const close = end + after.indexOf("}") + 1;
      const jsxOnly =
        text.slice(lineStart, open).trim() === "" && text.slice(close, lineEnd).trim() === "";
      if (jsxOnly) {
        start = open;
        end = close;
        before = text.slice(lineStart, start);
        after = text.slice(end, lineEnd);
      }
    }
    if (before.trim() === "" && after.trim() === "") {
      text = `${text.slice(0, lineStart)}${MARK}${text.slice(lineEnd)}`;
    } else if (after.trim() === "") {
      text = `${text.slice(0, lineStart)}${before.trimEnd()}${text.slice(lineEnd)}`;
    } else {
      text = `${text.slice(0, start)}${after.startsWith(" ") && before.endsWith(" ") ? after.slice(1) : after}${text.slice(lineEnd)}`;
    }
  }

  const kept: string[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] !== MARK) {
      kept.push(lines[index] ?? "");
      continue;
    }
    let next = index + 1;
    while (lines[next] === MARK) next += 1;
    const previous = kept.at(-1);
    const blankBefore = isBlank(previous) || kept.length === 0;
    if (blankBefore && (isBlank(lines[next]) || closesBlock(lines[next]))) {
      if (kept.length > 0) kept.pop();
    } else if (opensBlock(previous) && isBlank(lines[next])) {
      next += 1;
    }
    index = next - 1;
  }
  while (kept.length > 1 && isBlank(kept[0])) kept.shift();
  return kept.join("\n");
}

function main(): void {
  const [workDir] = process.argv.slice(2);
  if (workDir === undefined) throw new Error("usage: apply.ts <work-dir>");
  const comments: Extracted[] = JSON.parse(readFileSync(join(workDir, "comments.json"), "utf8"));
  const items: Item[] = readdirSync(join(workDir, "out"))
    .filter((name) => name.endsWith(".json"))
    .flatMap((name) => JSON.parse(readFileSync(join(workDir, "out", name), "utf8")).items);
  const category = new Map(items.map((item) => [item.id, item.cat]));
  const missing = comments.filter((comment) => !category.has(comment.id));
  if (missing.length > 0) throw new Error(`${missing.length} comments have no category`);

  const byFile = new Map<string, Extracted[]>();
  for (const comment of comments) {
    if (!DELETED.has(category.get(comment.id) ?? "")) continue;
    byFile.set(comment.file, [...(byFile.get(comment.file) ?? []), comment]);
  }
  let removed = 0;
  for (const [file, list] of byFile) {
    const source = readFileSync(file, "utf8");
    const next = strip(source, list);
    removed += source.split("\n").length - next.split("\n").length;
    writeFileSync(file, next);
  }
  const deleted = [...byFile.values()].reduce((sum, list) => sum + list.length, 0);
  console.log(`${deleted} comments deleted in ${byFile.size} files, ${removed} lines shed`);
}

if (import.meta.main) main();
