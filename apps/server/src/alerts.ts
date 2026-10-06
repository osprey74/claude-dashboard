// フェーズ4：アラート（放置・ファイル競合）
// 状況は定期的に評価し、続いている間は1件にまとめる。解消したら resolved にし、再発したら新しく出す。
// 利用者が閉じたもの（dismissed）は、その事象が解消するまで出し直さない

import type { Database } from "bun:sqlite";
import { remoteControlUrl, type AlertKind, type AlertView } from "@kanseishitsu/shared";
import type { ServerConfig } from "./config";

/** 編集として扱うツールと、パスの入っている項目 */
const EDIT_TOOLS: Record<string, string> = {
  Edit: "file_path",
  MultiEdit: "file_path",
  Write: "file_path",
  NotebookEdit: "notebook_path",
};

/** 人の応答が必要な待ち（作業が終わって次の指示を待っているだけの状態は含めない） */
const NEEDS_RESPONSE = ["許可待ち", "質問への回答待ち"];

/** PostToolUse で、編集したファイルを記録する */
export function recordTouch(
  db: Database,
  hostId: string,
  sessionId: string,
  payload: Record<string, unknown>,
  at: string,
): void {
  const tool = typeof payload.tool_name === "string" ? payload.tool_name : "";
  const field = EDIT_TOOLS[tool];
  if (!field) return;
  const input = payload.tool_input as Record<string, unknown> | undefined;
  const path = input?.[field];
  if (typeof path !== "string" || !path) return;
  const agentId = typeof payload.agent_id === "string" && payload.agent_id ? payload.agent_id : null;
  db.query("INSERT INTO file_touches (host_id, session_id, agent_id, path, created_at) VALUES (?, ?, ?, ?, ?)").run(
    hostId,
    sessionId,
    agentId,
    path,
    at,
  );
}

interface Wanted {
  key: string;
  kind: AlertKind;
  hostId: string;
  sessionId: string | null;
  detail: Record<string, unknown>;
}

function idleAlerts(db: Database, cfg: ServerConfig, now: Date): Wanted[] {
  const th = cfg.thresholds;
  const since = new Date(now.getTime() - th.idleAlertSec * 1000).toISOString();
  const hiddenBefore = new Date(now.getTime() - th.hideIdleAfterSec * 1000).toISOString();
  const rows = db
    .query<{ session_id: string; host_id: string; status_text: string; last_event_at: string }, [string, string]>(
      `SELECT session_id, host_id, status_text, last_event_at FROM sessions
       WHERE ended_at IS NULL AND status = 'wait' AND last_event_at <= ? AND last_event_at > ?`,
    )
    .all(since, hiddenBefore);
  return rows
    .filter((r) => NEEDS_RESPONSE.some((p) => r.status_text.startsWith(p)))
    .map((r) => ({
      // 待ち始めの時刻を鍵に含め、待ちの区切りごとに別のアラートにする
      key: `idle:${r.session_id}:${r.last_event_at}`,
      kind: "idle" as const,
      hostId: r.host_id,
      sessionId: r.session_id,
      detail: { waitText: r.status_text, waitingSince: r.last_event_at },
    }));
}

function conflictAlerts(db: Database, cfg: ServerConfig, now: Date): Wanted[] {
  const since = new Date(now.getTime() - cfg.thresholds.conflictWindowSec * 1000).toISOString();
  // 担当 = セッション + サブエージェント（メインは agent_id なし）
  const rows = db
    .query<{ host_id: string; path: string; session_id: string; agent_id: string | null; last_at: string }, [string]>(
      `SELECT host_id, path, session_id, agent_id, MAX(created_at) AS last_at FROM file_touches
       WHERE created_at > ? GROUP BY host_id, path, session_id, agent_id`,
    )
    .all(since);
  const byPath = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = `${r.host_id}\u0000${r.path}`;
    byPath.set(k, [...(byPath.get(k) ?? []), r]);
  }
  const out: Wanted[] = [];
  for (const group of byPath.values()) {
    if (group.length < 2) continue;
    const first = group[0]!;
    // 最後に編集したセッションを代表にする
    const latest = group.reduce((a, b) => (a.last_at >= b.last_at ? a : b));
    out.push({
      key: `conflict:${first.host_id}:${first.path}`,
      kind: "conflict",
      hostId: first.host_id,
      sessionId: latest.session_id,
      detail: { path: first.path, actors: group.map((g) => ({ sessionId: g.session_id, agentId: g.agent_id })) },
    });
  }
  return out;
}

/**
 * アラートを評価し直す。変化があれば true を返す（配信のきっかけにする）。
 * 古い編集記録もここで消す
 */
export function evaluateAlerts(db: Database, cfg: ServerConfig, now = new Date()): boolean {
  const at = now.toISOString();
  const wanted = [...idleAlerts(db, cfg, now), ...conflictAlerts(db, cfg, now)];
  let changed = false;
  db.transaction(() => {
    const active = db
      .query<{ alert_id: number; key: string; state: string; detail_json: string }, []>(
        "SELECT alert_id, key, state, detail_json FROM alerts WHERE state IN ('open', 'dismissed') AND kind IN ('idle', 'conflict')",
      )
      .all();
    const byKey = new Map(active.map((a) => [a.key, a]));
    const wantedKeys = new Set(wanted.map((w) => w.key));
    for (const w of wanted) {
      const json = JSON.stringify(w.detail);
      const cur = byKey.get(w.key);
      if (!cur) {
        db.query(
          `INSERT INTO alerts (key, kind, host_id, session_id, detail_json, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`,
        ).run(w.key, w.kind, w.hostId, w.sessionId, json, at, at);
        changed = true;
      } else if (cur.detail_json !== json) {
        db.query("UPDATE alerts SET detail_json = ?, session_id = ?, updated_at = ? WHERE alert_id = ?").run(
          json,
          w.sessionId,
          at,
          cur.alert_id,
        );
        changed = true;
      }
    }
    for (const a of active) {
      if (wantedKeys.has(a.key)) continue;
      db.query("UPDATE alerts SET state = 'resolved', resolved_at = ?, updated_at = ? WHERE alert_id = ?").run(at, at, a.alert_id);
      if (a.state === "open") changed = true;
    }
    // 競合の判定に要らなくなった編集記録は消す（1日分は残す）
    db.query("DELETE FROM file_touches WHERE created_at < ?").run(new Date(now.getTime() - 86400_000).toISOString());
  })();
  return changed;
}

export function dismissAlert(db: Database, alertId: number, now = new Date()): boolean {
  const at = now.toISOString();
  return db.query("UPDATE alerts SET state = 'dismissed', updated_at = ? WHERE alert_id = ? AND state = 'open'").run(at, alertId)
    .changes > 0;
}

/** 画面用：未対応のアラート */
export function openAlerts(db: Database): AlertView[] {
  const rows = db
    .query<
      {
        alert_id: number;
        kind: AlertKind;
        session_id: string | null;
        detail_json: string;
        created_at: string;
        label: string | null;
        project: string | null;
        remote_session_id: string | null;
      },
      []
    >(
      `SELECT a.alert_id, a.kind, a.session_id, a.detail_json, a.created_at, h.label, s.project, s.remote_session_id
       FROM alerts a LEFT JOIN hosts h ON h.host_id = a.host_id LEFT JOIN sessions s ON s.session_id = a.session_id
       WHERE a.state = 'open' ORDER BY a.created_at DESC LIMIT 50`,
    )
    .all();
  return rows.map((r) => {
    const d = JSON.parse(r.detail_json) as Record<string, unknown>;
    const view: AlertView = {
      alertId: r.alert_id,
      kind: r.kind,
      hostLabel: r.label ?? "不明な PC",
      sessionId: r.session_id,
      project: r.project,
      createdAt: r.created_at,
    };
    if (r.kind === "idle") {
      view.waitText = String(d.waitText ?? "");
      view.waitingSince = String(d.waitingSince ?? r.created_at);
      view.remoteUrl = remoteControlUrl(r.remote_session_id);
    } else if (r.kind === "conflict") {
      view.path = String(d.path ?? "");
      view.actors = actorLabels(db, (d.actors as { sessionId: string; agentId: string | null }[]) ?? []);
    }
    return view;
  });
}

/** 担当の表示名：メインは「<プロジェクト>（メイン）」、サブエージェントは種類とモデル */
function actorLabels(db: Database, actors: { sessionId: string; agentId: string | null }[]): string[] {
  return actors.map((a) => {
    const project =
      db.query<{ project: string }, [string]>("SELECT project FROM sessions WHERE session_id = ?").get(a.sessionId)?.project ??
      "不明";
    if (!a.agentId) return `${project}（メイン）`;
    const p = db
      .query<{ agent_type: string | null; model: string | null }, [string]>(
        "SELECT agent_type, model FROM players WHERE agent_id = ? ORDER BY started_at DESC LIMIT 1",
      )
      .get(a.agentId);
    const name = [p?.agent_type ?? "サブエージェント", p?.model].filter(Boolean).join(" ・ ");
    return `${project}（${name}）`;
  });
}
