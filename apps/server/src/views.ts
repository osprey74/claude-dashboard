// 詳細パネルと履歴の API

import type { Database } from "bun:sqlite";
import { parseTaskNotification,
  AGENT_TOOLS,
  isCodexCall,
  statusFromHook,
  type HistoryFilter,
  type HistoryItem,
  type HistoryKind,
  type SessionDetail,
  type TodoItem,
} from "@kanseishitsu/shared";
import type { ServerConfig } from "./config";
import { SESSION_COLUMNS, toSessionViews, type SessionRow } from "./state";

export function sessionDetail(db: Database, cfg: ServerConfig, sessionId: string, now = new Date()): SessionDetail | null {
  const row = db
    .query<SessionRow & { last_result: string | null; todos_json: string | null }, [string]>(
      `SELECT ${SESSION_COLUMNS}, last_result, todos_json FROM sessions WHERE session_id = ?`,
    )
    .get(sessionId);
  if (!row) return null;
  const [session] = toSessionViews(db, cfg, [row], now);
  const host = db
    .query<{ label: string; hostname: string | null; os: string | null }, [string]>(
      "SELECT label, hostname, os FROM hosts WHERE host_id = ?",
    )
    .get(row.host_id);
  const prompt = db
    .query<{ text: string; created_at: string }, [string]>(
      "SELECT text, created_at FROM prompts WHERE session_id = ? ORDER BY prompt_id DESC LIMIT 1",
    )
    .get(sessionId);
  // 作業結果は直近のプロンプトより後の Stop のものだけを出す（古い結果を今の作業の結果に見せない）
  const resultAt = db
    .query<{ created_at: string }, [string]>(
      "SELECT created_at FROM events WHERE session_id = ? AND type = 'Stop' ORDER BY event_id DESC LIMIT 1",
    )
    .get(sessionId)?.created_at;
  const resultIsCurrent = row.last_result && resultAt && (!row.last_prompt_at || resultAt >= row.last_prompt_at);
  let todos: TodoItem[] | null = null;
  try {
    todos = row.todos_json ? JSON.parse(row.todos_json) : null;
  } catch {
    todos = null;
  }
  return {
    session: session!,
    hostLabel: host?.label ?? "",
    hostSub: [host?.os, host?.hostname && host.hostname !== host.label ? host.hostname : null].filter(Boolean).join(" ・ "),
    prompt: prompt ? { text: prompt.text, at: prompt.created_at } : null,
    todos,
    result: resultIsCurrent ? { text: row.last_result!, at: resultAt! } : null,
  };
}

const HISTORY_TYPES: Record<HistoryFilter, string[]> = {
  all: ["UserPromptSubmit", "Stop", "StopFailure", "Notification", "PermissionRequest", "SessionStart", "SessionEnd", "PreToolUse"],
  prompt: ["UserPromptSubmit"],
  done: ["Stop"],
  err: ["StopFailure"],
};

const excerpt = (s: string | undefined, n = 120) => {
  if (!s) return "";
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n) + "…" : one;
};
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const obj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : undefined);

/** 1件のイベントを履歴の1行にする。履歴に出さないイベントは null */
function toHistory(type: string, tool: string | null, p: Record<string, unknown>): { kind: HistoryKind; text: string } | null {
  switch (type) {
    case "UserPromptSubmit": {
      const note = parseTaskNotification(p.prompt);
      if (note) return { kind: "done", text: `バックグラウンドの作業が終了${note.status ? ` ・ ${note.status}` : ""}` };
      return { kind: "prompt", text: "プロンプト受信 ・ " + excerpt(str(p.prompt)) };
    }
    case "Stop":
      return { kind: "done", text: "作業完了" + (str(p.last_assistant_message) ? " ・ " + excerpt(str(p.last_assistant_message)) : "") };
    case "StopFailure":
      return { kind: "err", text: "API エラー ・ " + (str(p.error_type) ?? "unknown") };
    case "Notification":
    case "PermissionRequest": {
      const ch = statusFromHook(type, p, "run");
      if (ch?.status !== "wait") return null;
      return { kind: "wait", text: ch.statusText + (str(p.message) ? " ・ " + excerpt(str(p.message), 80) : "") };
    }
    case "SessionStart":
      if (p.source === "compact" || p.source === "clear") return null;
      return { kind: "start", text: p.source === "resume" ? "セッション再開" : "セッション開始" };
    case "SessionEnd":
      return { kind: "end", text: "セッション終了" };
    case "PreToolUse": {
      const input = obj(p.tool_input);
      if (tool && AGENT_TOOLS.has(tool)) {
        const type = str(input?.subagent_type);
        return { kind: "player", text: `プレイヤー起動 ・ ${type ? type + "：" : ""}${excerpt(str(input?.description), 80)}` };
      }
      if (isCodexCall(tool ?? undefined, input)) {
        return { kind: "player", text: "Codex CLI 起動 ・ " + excerpt(str(input?.description) ?? str(input?.command), 80) };
      }
      return null;
    }
    default:
      return null;
  }
}

export function history(db: Database, filter: HistoryFilter, limit: number, before?: number): HistoryItem[] {
  const types = HISTORY_TYPES[filter] ?? HISTORY_TYPES.all;
  const out: HistoryItem[] = [];
  let cursor = before ?? Number.MAX_SAFE_INTEGER;
  // PreToolUse など履歴に出さないものを読み飛ばすため、まとめて読みながら必要数を集める
  for (let round = 0; round < 10 && out.length < limit; round++) {
    const rows = db
      .query<
        {
          event_id: number;
          created_at: string;
          session_id: string | null;
          type: string;
          tool_name: string | null;
          payload_json: string;
          label: string;
          project: string | null;
        },
        (string | number)[]
      >(
        `SELECT e.event_id, e.created_at, e.session_id, e.type, e.tool_name, e.payload_json, h.label, s.project
         FROM events e JOIN hosts h ON h.host_id = e.host_id LEFT JOIN sessions s ON s.session_id = e.session_id
         WHERE e.event_id < ? AND e.type IN (${types.map(() => "?").join(",")})
           AND (e.type <> 'PreToolUse' OR e.tool_name IN ('Agent', 'Task', 'Bash', 'PowerShell') OR e.tool_name LIKE 'mcp\\_%codex%' ESCAPE '\\')
         ORDER BY e.event_id DESC LIMIT ?`,
      )
      .all(cursor, ...types, limit * 4);
    if (rows.length === 0) break;
    for (const r of rows) {
      cursor = r.event_id;
      let p: Record<string, unknown> = {};
      try {
        p = JSON.parse(r.payload_json);
      } catch {
        continue;
      }
      const h = toHistory(r.type, r.tool_name, p);
      if (!h) continue;
      out.push({ id: r.event_id, at: r.created_at, sessionId: r.session_id, hostLabel: r.label, project: r.project ?? "", ...h });
      if (out.length >= limit) break;
    }
  }
  return out;
}
