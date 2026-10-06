// hooks・statusLine の受信内容を保存し、セッション状態を更新する

import type { Database } from "bun:sqlite";
import {
  modelLabel,
  projectFromCwd,
  statusFromHook,
  type HookIngest,
  type SessionStatus,
  type StatuslineIngest,
} from "@kanseishitsu/shared";
import type { HostRow } from "./auth";

interface SessionRow {
  session_id: string;
  status: SessionStatus;
  ended_at: string | null;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

function touchHost(db: Database, host: HostRow, info: HookIngest["host"], now: string): void {
  db.query(
    "UPDATE hosts SET hostname = ?, os = ?, label = COALESCE(?, label), agent_version = ?, last_seen_at = ? WHERE host_id = ?",
  ).run(info.hostname ?? null, info.os ?? null, info.label || null, info.agentVersion ?? null, now, host.host_id);
}

export function processHook(db: Database, host: HostRow, body: HookIngest, now = new Date()): void {
  const at = now.toISOString();
  const payload = body.payload ?? {};
  const event = body.event || str(payload.hook_event_name) || "unknown";
  const sessionId = str(payload.session_id) ?? null;

  db.transaction(() => {
    touchHost(db, host, body.host, at);

    db.query(
      "INSERT INTO events (session_id, host_id, type, tool_name, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(sessionId, host.host_id, event, str(payload.tool_name) ?? null, JSON.stringify(payload), at);

    if (event === "UserPromptSubmit" && sessionId && str(payload.prompt)) {
      db.query("INSERT INTO prompts (session_id, text, created_at) VALUES (?, ?, ?)").run(
        sessionId,
        str(payload.prompt)!,
        at,
      );
    }

    if (!sessionId) return;
    const existing = db
      .query<SessionRow, [string]>("SELECT session_id, status, ended_at FROM sessions WHERE session_id = ?")
      .get(sessionId);
    const change = statusFromHook(event, payload, existing && !existing.ended_at ? existing.status : null);
    const cwd = str(payload.cwd) ?? null;
    const model = modelLabel(str(payload.model) ?? str(payload.model_from_transcript)) ?? null;

    if (!existing) {
      const st = change ?? { status: "wait" as const, statusText: "状態未取得" };
      db.query(
        `INSERT INTO sessions (session_id, host_id, project, cwd, model, status, status_text, started_at, last_event_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        sessionId,
        host.host_id,
        projectFromCwd(cwd),
        cwd,
        model,
        st.status,
        st.statusText,
        at,
        at,
        st.status === "ended" ? at : null,
      );
      return;
    }

    // 終了済みのセッションにイベントが来た場合（--resume など）は一覧に戻す
    const endedAt = change?.status === "ended" ? at : change ? null : existing.ended_at;
    db.query(
      `UPDATE sessions SET
         host_id = ?,
         cwd = COALESCE(?, cwd),
         project = CASE WHEN ? IS NULL THEN project ELSE ? END,
         model = COALESCE(?, model),
         status = COALESCE(?, status),
         status_text = COALESCE(?, status_text),
         last_event_at = ?,
         ended_at = ?
       WHERE session_id = ?`,
    ).run(
      host.host_id,
      cwd,
      cwd,
      projectFromCwd(cwd),
      model,
      change?.status ?? null,
      change?.statusText ?? null,
      at,
      endedAt,
      sessionId,
    );
  })();
}

/** フェーズ1ゲート確認用：ホストごとに最後に受けた statusLine の内容（伏せ字化済み） */
export const lastStatusline = new Map<string, { at: string; payload: Record<string, unknown> }>();

export function processStatusline(db: Database, host: HostRow, body: StatuslineIngest, now = new Date()): void {
  const at = now.toISOString();
  const p = body.payload ?? {};
  lastStatusline.set(host.host_id, { at, payload: p });
  const sessionId = str(p.session_id);
  const model = obj(p.model);
  const label = modelLabel(str(model?.id)) ?? modelLabel(str(model?.display_name));
  const ctx = num(obj(p.context_window)?.used_percentage) ?? null;
  const cwd = str(obj(p.workspace)?.current_dir) ?? str(p.cwd) ?? null;

  db.transaction(() => {
    touchHost(db, host, body.host, at);

    if (sessionId) {
      const existing = db
        .query<SessionRow, [string]>("SELECT session_id, status, ended_at FROM sessions WHERE session_id = ?")
        .get(sessionId);
      if (!existing) {
        db.query(
          `INSERT INTO sessions (session_id, host_id, project, cwd, model, status, status_text, ctx_pct, started_at, last_event_at)
           VALUES (?, ?, ?, ?, ?, 'wait', '状態未取得', ?, ?, ?)`,
        ).run(sessionId, host.host_id, projectFromCwd(cwd), cwd, label, ctx, at, at);
      } else {
        // statusLine はアシスタントの応答などで更新されるため、稼働中なら生存の印として扱う
        db.query(
          `UPDATE sessions SET model = COALESCE(?, model), ctx_pct = COALESCE(?, ctx_pct),
             last_event_at = CASE WHEN status = 'run' THEN ? ELSE last_event_at END
           WHERE session_id = ?`,
        ).run(label, ctx, at, sessionId);
      }
    }

    const rl = obj(p.rate_limits);
    if (rl) recordUsage(db, host.host_id, sessionId ?? null, rl, at);
  })();
}

const epochToIso = (v: unknown): string | null => {
  const n = num(v);
  return n === undefined ? null : new Date(n * 1000).toISOString();
};

function recordUsage(
  db: Database,
  hostId: string,
  sessionId: string | null,
  rl: Record<string, unknown>,
  at: string,
): void {
  const five = obj(rl.five_hour);
  const seven = obj(rl.seven_day);
  if (!five && !seven) return;
  const row = {
    fp: num(five?.used_percentage) ?? null,
    fr: epochToIso(five?.resets_at),
    sp: num(seven?.used_percentage) ?? null,
    sr: epochToIso(seven?.resets_at),
  };
  // 値が変わらない間は 1 分に 1 回だけ記録する
  const last = db
    .query<
      { taken_at: string; five_hour_pct: number | null; seven_day_pct: number | null },
      [string]
    >("SELECT taken_at, five_hour_pct, seven_day_pct FROM usage_snapshots WHERE host_id = ? ORDER BY taken_at DESC LIMIT 1")
    .get(hostId);
  if (
    last &&
    last.five_hour_pct === row.fp &&
    last.seven_day_pct === row.sp &&
    Date.parse(at) - Date.parse(last.taken_at) < 60_000
  )
    return;
  db.query(
    `INSERT INTO usage_snapshots (taken_at, host_id, session_id, five_hour_pct, five_hour_reset, seven_day_pct, seven_day_reset)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(at, hostId, sessionId, row.fp, row.fr, row.sp, row.sr);
}
