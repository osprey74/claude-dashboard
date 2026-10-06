// 画面に渡す現在の状態（PC・セッション一覧と件数）を組み立てる

import type { Database } from "bun:sqlite";
import { effectiveStatus, type HostView, type SessionStatus, type StateSnapshot, type UsageView } from "@kanseishitsu/shared";
import type { ServerConfig } from "./config";

interface HostRow {
  host_id: string;
  hostname: string | null;
  os: string | null;
  label: string;
  agent_version: string | null;
  last_seen_at: string | null;
}

interface SessionRow {
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
}

interface UsageRow {
  host_id: string;
  taken_at: string;
  five_hour_pct: number | null;
  five_hour_reset: string | null;
  seven_day_pct: number | null;
  seven_day_reset: string | null;
}

const STATUS_ORDER: Record<SessionStatus, number> = { err: 0, wait: 1, run: 2, ended: 3 };

export function buildSnapshot(db: Database, cfg: ServerConfig, now = new Date()): StateSnapshot {
  const hosts = db
    .query<HostRow, []>(
      "SELECT host_id, hostname, os, label, agent_version, last_seen_at FROM hosts WHERE revoked_at IS NULL ORDER BY label",
    )
    .all();
  const rows = db
    .query<SessionRow, []>(
      `SELECT session_id, host_id, project, cwd, model, status, status_text, ctx_pct, started_at, last_event_at
       FROM sessions WHERE ended_at IS NULL`,
    )
    .all();

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

  for (const r of rows) {
    const last = new Date(r.last_event_at);
    const eff = effectiveStatus({ status: r.status, statusText: r.status_text }, last, now, cfg.thresholds);
    // SessionEnd が届かずに残ったセッションは、長時間動きがなければ一覧から外す（履歴には残る）
    if (eff.status !== "run" && now.getTime() - last.getTime() > cfg.thresholds.hideIdleAfterSec * 1000) continue;
    const host = byHost.get(r.host_id);
    if (!host) continue;
    if (eff.status === "run" || eff.status === "wait" || eff.status === "err") counts[eff.status]++;
    host.sessions.push({
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
    });
  }
  for (const h of byHost.values()) {
    h.sessions.sort(
      (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.lastEventAt.localeCompare(a.lastEventAt),
    );
  }

  const usage: UsageView[] = db
    .query<UsageRow, []>(
      `SELECT u.* FROM usage_snapshots u
       JOIN (SELECT host_id, MAX(taken_at) AS t FROM usage_snapshots GROUP BY host_id) m
         ON u.host_id = m.host_id AND u.taken_at = m.t`,
    )
    .all()
    .map((u) => ({
      hostId: u.host_id,
      takenAt: u.taken_at,
      fiveHour: u.five_hour_pct === null ? null : { usedPct: u.five_hour_pct, resetsAt: u.five_hour_reset },
      sevenDay: u.seven_day_pct === null ? null : { usedPct: u.seven_day_pct, resetsAt: u.seven_day_reset },
    }));

  return { generatedAt: now.toISOString(), hosts: [...byHost.values()], counts, usage };
}

/** generatedAt を除いた内容の指紋。変化があったときだけ配信するために使う */
export function snapshotKey(s: StateSnapshot): string {
  return JSON.stringify({ ...s, generatedAt: undefined });
}
