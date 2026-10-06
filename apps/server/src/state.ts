// 画面に渡す現在の状態（PC・セッション一覧と件数）を組み立てる

import type { Database } from "bun:sqlite";
import {
  effectiveStatus,
  type HostView,
  type PlayerKind,
  type PlayerStatus,
  type PlayerView,
  type SessionStatus,
  type SessionView,
  type StateSnapshot,
  type UsageView,
} from "@kanseishitsu/shared";
import type { ServerConfig } from "./config";

interface HostRow {
  host_id: string;
  hostname: string | null;
  os: string | null;
  label: string;
  agent_version: string | null;
  last_seen_at: string | null;
}

export interface SessionRow {
  session_id: string;
  host_id: string;
  project: string;
  cwd: string | null;
  model: string | null;
  status: SessionStatus;
  status_text: string;
  ctx_pct: number | null;
  started_at: string;
  last_event_at: string;
  last_prompt_at: string | null;
}

interface PlayerRow {
  player_id: string;
  session_id: string;
  kind: PlayerKind;
  agent_type: string | null;
  model: string | null;
  task: string | null;
  status: PlayerStatus;
  started_at: string;
  ended_at: string | null;
}

interface UsageRow {
  host_id: string;
  label: string;
  taken_at: string;
  five_hour_pct: number | null;
  five_hour_reset: string | null;
  seven_day_pct: number | null;
  seven_day_reset: string | null;
}

export const SESSION_COLUMNS =
  "session_id, host_id, project, cwd, model, status, status_text, ctx_pct, started_at, last_event_at, last_prompt_at";

const STATUS_ORDER: Record<SessionStatus, number> = { err: 0, wait: 1, run: 2, ended: 3 };

/** 直近のプロンプト以降に起動した、または稼働中のプレイヤー（セッションごと） */
function loadPlayers(db: Database, sessions: SessionRow[]): Map<string, PlayerView[]> {
  const out = new Map<string, PlayerView[]>();
  if (sessions.length === 0) return out;
  const since = new Map(sessions.map((s) => [s.session_id, s.last_prompt_at ?? ""]));
  const rows = db
    .query<PlayerRow, string[]>(
      `SELECT player_id, session_id, kind, agent_type, model, task, status, started_at, ended_at FROM players
       WHERE session_id IN (${sessions.map(() => "?").join(",")}) ORDER BY started_at`,
    )
    .all(...sessions.map((s) => s.session_id));
  for (const r of rows) {
    if (r.status !== "run" && r.started_at < (since.get(r.session_id) ?? "")) continue;
    const list = out.get(r.session_id) ?? [];
    list.push({
      playerId: r.player_id,
      kind: r.kind,
      model: r.model,
      agentType: r.agent_type,
      task: r.task,
      status: r.status,
      startedAt: r.started_at,
      endedAt: r.ended_at,
    });
    out.set(r.session_id, list);
  }
  return out;
}

export function toSessionViews(db: Database, cfg: ServerConfig, rows: SessionRow[], now: Date): SessionView[] {
  const players = loadPlayers(db, rows);
  return rows.map((r) => {
    const eff = effectiveStatus({ status: r.status, statusText: r.status_text }, new Date(r.last_event_at), now, cfg.thresholds);
    return {
      sessionId: r.session_id,
      hostId: r.host_id,
      project: r.project,
      cwd: r.cwd,
      model: r.model,
      status: eff.status,
      statusText: eff.statusText,
      ctxPct: r.ctx_pct,
      startedAt: r.started_at,
      lastEventAt: r.last_event_at,
      players: players.get(r.session_id) ?? [],
    };
  });
}

export function buildSnapshot(db: Database, cfg: ServerConfig, now = new Date()): StateSnapshot {
  const hosts = db
    .query<HostRow, []>(
      "SELECT host_id, hostname, os, label, agent_version, last_seen_at FROM hosts WHERE revoked_at IS NULL ORDER BY label",
    )
    .all();
  const rows = db.query<SessionRow, []>(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE ended_at IS NULL`).all();

  const counts = { run: 0, wait: 0, err: 0 };
  const byHost = new Map<string, HostView>(
    hosts.map((h) => [
      h.host_id,
      {
        hostId: h.host_id,
        hostname: h.hostname ?? h.label,
        os: h.os ?? "",
        label: h.label,
        agentVersion: h.agent_version,
        lastSeenAt: h.last_seen_at,
        sessions: [],
      },
    ]),
  );

  for (const s of toSessionViews(db, cfg, rows, now)) {
    // SessionEnd が届かずに残ったセッションは、長時間動きがなければ一覧から外す（履歴には残る）
    if (s.status !== "run" && now.getTime() - Date.parse(s.lastEventAt) > cfg.thresholds.hideIdleAfterSec * 1000) continue;
    const host = byHost.get(s.hostId);
    if (!host) continue;
    if (s.status === "run" || s.status === "wait" || s.status === "err") counts[s.status]++;
    host.sessions.push(s);
  }
  for (const h of byHost.values()) {
    h.sessions.sort(
      (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.lastEventAt.localeCompare(a.lastEventAt),
    );
  }

  // 利用枠はアカウント単位の値。届いた PC ごとの最新値を新しい順に返す
  const usage: UsageView[] = db
    .query<UsageRow, []>(
      `SELECT u.*, h.label FROM usage_snapshots u
       JOIN (SELECT host_id, MAX(taken_at) AS t FROM usage_snapshots GROUP BY host_id) m
         ON u.host_id = m.host_id AND u.taken_at = m.t
       JOIN hosts h ON h.host_id = u.host_id
       ORDER BY u.taken_at DESC`,
    )
    .all()
    .map((u) => ({
      hostId: u.host_id,
      hostLabel: u.label,
      takenAt: u.taken_at,
      fiveHour: u.five_hour_pct === null ? null : { usedPct: u.five_hour_pct, resetsAt: u.five_hour_reset },
      sevenDay: u.seven_day_pct === null ? null : { usedPct: u.seven_day_pct, resetsAt: u.seven_day_reset },
    }));

  return {
    generatedAt: now.toISOString(),
    ui: { ctxWarnPct: cfg.thresholds.ctxWarnPct },
    hosts: [...byHost.values()],
    counts,
    usage,
  };
}

/** generatedAt を除いた内容の指紋。変化があったときだけ配信するために使う */
export function snapshotKey(s: StateSnapshot): string {
  return JSON.stringify({ ...s, generatedAt: undefined });
}
