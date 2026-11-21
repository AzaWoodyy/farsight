import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Extracted } from "./extract.ts";

type Item = { id: number; cat: string };

const DELETED = new Set(["T", "S", "E", "D"]);
const KEPT = new Set(["U"]);

function isBlank(line: string | undefined): boolean {
  return line !== undefined && line.trim() === "";
}

function opensBlock(line: string | undefined): boolean {
  return line === undefined || /[{([]$/u.test(line.trimEnd());
}

function closesBlock(line: string | undefined): boolean {
  return line === undefined || /^[)\]}]/u.test(line.trimStart());
}

export function strip(source: string, comments: readonly Extracted[]): string {
  const MARK = "\u0000";
  let text = source;
  for (const comment of [...comments].sort((a, b) => b.start - a.start)) {
    if (text.slice(comment.start, comment.end) !== comment.text) {
      throw new Error(`${comment.file}:${comment.line} moved since the extraction; extract again`);
    }
    const { start, end } = comment.jsx ?? comment;
    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    const newline = text.indexOf("\n", end);
    const lineEnd = newline === -1 ? text.length : newline;
    const before = text.slice(lineStart, start);
    const after = text.slice(end, lineEnd);
    if (before.trim() === "" && after.trim() === "") {
      text = `${text.slice(0, lineStart)}${MARK}${text.slice(lineEnd)}`;
    } else if (after.trim() === "") {
      text = `${text.slice(0, lineStart)}${before.trimEnd()}${text.slice(lineEnd)}`;
    } else if (comment.text.includes("\n")) {
      text = `${text.slice(0, start)}\n${text.slice(end)}`;
    } else {
      const glued = /[\w$]$/u.test(before) && /^[\w$]/u.test(after);
      text = `${text.slice(0, start)}${glued ? " " : ""}${text.slice(end)}`;
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
  const category = new Map<number, string>();
  for (const item of items) {
    if (category.has(item.id)) throw new Error(`comment ${item.id} is classified twice`);
    if (!DELETED.has(item.cat) && !KEPT.has(item.cat)) {
      throw new Error(`comment ${item.id} has the unknown category ${item.cat}`);
    }
    category.set(item.id, item.cat);
  }
  const known = new Set(comments.map((comment) => comment.id));
  const missing = comments.filter((comment) => !category.has(comment.id));
  const foreign = items.filter((item) => !known.has(item.id));
  if (missing.length > 0) throw new Error(`${missing.length} comments have no category`);
  if (foreign.length > 0) throw new Error(`${foreign.length} categories name no extracted comment`);
  for (const file of new Set(comments.map((comment) => comment.file))) {
    const hash = createHash("sha256").update(readFileSync(file, "utf8")).digest("hex");
    const expected = comments.find((comment) => comment.file === file)?.hash;
    if (hash !== expected) throw new Error(`${file} changed since the extraction; extract again`);
  }

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
