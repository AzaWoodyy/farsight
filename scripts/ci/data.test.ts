import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractRaw } from "./data";

function fixture(name: string, type = "0", content = "{}") {
  const header = Buffer.alloc(512);

  header.write(name, 0);
  header.write(content.length.toString(8).padStart(11, "0"), 124);
  header.write(type, 156);

  return Buffer.concat([header, Buffer.from(content), Buffer.alloc((512 - content.length % 512) % 512), Buffer.alloc(1024)]);
}

const hash = createHash("sha256").update("{}").digest("hex");

test("raw extraction rejects traversal, symlinks, incomplete datasets and altered content", () => {
  const directory = mkdtempSync(join(tmpdir(), "ci-raw-"));
  const tar = join(directory, "raw.tar");
  const out = join(directory, "out");

  try {
    for (const [name, type] of [["../games.json", "0"], ["games.json", "2"]]) {
      writeFileSync(tar, fixture(name, type));
      expect(() => extractRaw(tar, out, { "games.json": hash })).toThrow("Unexpected file");
    }

    writeFileSync(tar, fixture("games.json"));
    expect(() => extractRaw(tar, out, { "games.json": hash, "players.json": hash })).toThrow("Missing raw datasets");
    writeFileSync(tar, fixture("games.json", "0", "[]"));
    expect(() => extractRaw(tar, out, { "games.json": hash })).toThrow("checksum mismatch");
    writeFileSync(tar, fixture("games.json"));
    extractRaw(tar, out, { "games.json": hash });
    expect(readFileSync(join(out, "games.json"), "utf8")).toBe("{}");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
