// 会話記録（transcript_path の JSONL）の末尾から、直近の応答のモデル ID を読み取る。
// VS Code 拡張やデスクトップアプリでは statusLine が動かず、SessionStart にも model が入らないことがあるための補完。

import { closeSync, fstatSync, openSync, readSync } from "node:fs";

const TAIL_BYTES = 256 * 1024;

export function modelFromTranscript(path: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString("utf8").split("\n");
    // 先頭行は途中から読んでいる可能性があるため、JSON として読めない行は飛ばす
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.trim();
      if (!line.includes('"assistant"')) continue;
      try {
        const d = JSON.parse(line);
        if (d?.type !== "assistant" || d.isSidechain) continue;
        const model = d.message?.model;
        if (typeof model === "string" && model && !model.startsWith("<")) return model;
      } catch {
        // 壊れた行は無視する
      }
    }
  } catch {
    // ファイルがない・読めない場合は何もしない
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return undefined;
}
