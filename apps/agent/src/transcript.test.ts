import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelFromTranscript } from "./transcript";

const write = (lines: unknown[]) => {
  const p = join(mkdtempSync(join(tmpdir(), "ks-")), "t.jsonl");
  writeFileSync(p, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
  return p;
};

describe("modelFromTranscript", () => {
  test("直近のメイン応答のモデルを返す", () => {
    const p = write([
      { type: "assistant", message: { model: "claude-sonnet-5-5" } },
      { type: "user", message: { content: "x" } },
      { type: "assistant", message: { model: "claude-opus-5-5" } },
      { type: "assistant", isSidechain: true, message: { model: "claude-haiku-4-5-20251001" } },
      { type: "assistant", message: { model: "<synthetic>" } },
      "{壊れた行",
      { type: "system" },
    ]);
    expect(modelFromTranscript(p)).toBe("claude-opus-5-5");
  });
  test("ファイルがなければ undefined", () => {
    expect(modelFromTranscript("/no/such/file.jsonl")).toBeUndefined();
  });
});
