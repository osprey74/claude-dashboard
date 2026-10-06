// 保持期間（既定 15 日）を過ぎた記録を消す。プロンプトの本文などを含むため、ためすぎないようにする。
// 消さないもの：PC の登録とトークン（hosts）、通知の購読（push_subscriptions）、未対応のアラート

import type { Database } from "bun:sqlite";

export function purgeOld(db: Database, days: number, now = new Date()): Record<string, number> {
  const cutoff = new Date(now.getTime() - days * 86400_000).toISOString();
  const out: Record<string, number> = {};
  const run = (name: string, sql: string) => {
    out[name] = (out[name] ?? 0) + db.query(sql).run(cutoff).changes;
  };
  db.transaction(() => {
    // 最後のイベントから保持期間が過ぎたセッションは、プレイヤーと一緒に消す
    run("players", "DELETE FROM players WHERE session_id IN (SELECT session_id FROM sessions WHERE last_event_at < ?)");
    run("sessions", "DELETE FROM sessions WHERE last_event_at < ?");
    run("events", "DELETE FROM events WHERE created_at < ?");
    run("prompts", "DELETE FROM prompts WHERE created_at < ?");
    run("alerts", "DELETE FROM alerts WHERE state IN ('resolved', 'dismissed') AND updated_at < ?");
    run("usage_snapshots", "DELETE FROM usage_snapshots WHERE taken_at < ?");
    run("session_costs", "DELETE FROM session_costs WHERE taken_at < ?");
    run("transcript_costs", "DELETE FROM transcript_costs WHERE bucket_start < ?");
    run("file_touches", "DELETE FROM file_touches WHERE created_at < ?");
  })();
  return out;
}
