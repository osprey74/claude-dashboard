// 会話記録（メインとサブエージェント）から、モデルごとのトークン数を数える。
// 記録は追記されていくので、前回読んだ位置を ~/.kanseishitsu/usage/<セッション>.json に覚えて、続きだけを読む。
// 1つの応答は内容ブロックごとに複数の行に分かれ、同じ usage が繰り返されるため、message.id で重複を除く

import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { TokenCounts } from "@kanseishitsu/shared";
import { AGENT_DIR } from "./common";

interface FileState {
  offset: number;
  lastId: string;
}
interface UsageState {
  files: Record<string, FileState>;
  byModel: Record<string, TokenCounts>;
}

const STATE_DIR = join(AGENT_DIR, "usage");
/** 1回に読む上限（初回に大きな記録を読むときも hooks を長引かせない） */
const MAX_READ = 64 * 1024 * 1024;

function readFrom(path: string, offset: number): { text: string; end: number } {
  const size = statSync(path).size;
  if (size <= offset) return { text: "", end: size < offset ? 0 : offset };
  const len = Math.min(size - offset, MAX_READ);
  const buf = Buffer.alloc(len);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, len, offset);
  } finally {
    closeSync(fd);
  }
  // 書きかけの最後の行は次回に回す
  const lastNl = buf.lastIndexOf(0x0a);
  if (lastNl < 0) return { text: "", end: offset };
  return { text: buf.subarray(0, lastNl + 1).toString("utf8"), end: offset + lastNl + 1 };
}

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function add(state: UsageState, model: string, u: Record<string, unknown>): void {
  const c = (state.byModel[model] ??= { input: 0, output: 0, cacheRead: 0, cache5m: 0, cache1h: 0 });
  c.input += n(u.input_tokens);
  c.output += n(u.output_tokens);
  c.cacheRead += n(u.cache_read_input_tokens);
  const cc = u.cache_creation as Record<string, unknown> | undefined;
  if (cc && (cc.ephemeral_5m_input_tokens !== undefined || cc.ephemeral_1h_input_tokens !== undefined)) {
    c.cache5m += n(cc.ephemeral_5m_input_tokens);
    c.cache1h += n(cc.ephemeral_1h_input_tokens);
  } else {
    c.cache5m += n(u.cache_creation_input_tokens);
  }
}

/** セッションの累計（モデルごと）。会話記録が見つからなければ null */
export function sessionTokenUsage(sessionId: unknown, transcriptPath: unknown): Record<string, TokenCounts> | null {
  if (typeof sessionId !== "string" || !/^[\w-]+$/.test(sessionId) || typeof transcriptPath !== "string") return null;
  if (!existsSync(transcriptPath)) return null;
  const statePath = join(STATE_DIR, `${sessionId}.json`);
  let state: UsageState = { files: {}, byModel: {} };
  try {
    state = JSON.parse(readFileSync(statePath, "utf8")) as UsageState;
  } catch {
    // 初回
  }
  const subDir = join(dirname(transcriptPath), basename(transcriptPath, ".jsonl"), "subagents");
  const files = [transcriptPath];
  try {
    for (const f of readdirSync(subDir)) if (f.endsWith(".jsonl")) files.push(join(subDir, f));
  } catch {
    // サブエージェントなし
  }
  for (const f of files) {
    const fs = (state.files[f] ??= { offset: 0, lastId: "" });
    const { text, end } = readFrom(f, fs.offset);
    for (const line of text.split("\n")) {
      if (!line.includes('"usage"')) continue;
      let d: Record<string, unknown>;
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }
      const m = d.message as Record<string, unknown> | undefined;
      const u = m?.usage as Record<string, unknown> | undefined;
      const id = typeof m?.id === "string" ? m.id : "";
      if (d.type !== "assistant" || !u || !id || id === fs.lastId) continue;
      fs.lastId = id;
      add(state, typeof m?.model === "string" ? m.model : "unknown", u);
    }
    fs.offset = end;
  }
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(statePath, JSON.stringify(state));
  } catch {
    // 覚えられなくても、今回の値は送る
  }
  return state.byModel;
}
