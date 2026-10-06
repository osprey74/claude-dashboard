import { describe, expect, test } from "bun:test";
import { issueHostToken } from "./auth";
import { openDb } from "./db";
import { purgeOld } from "./retention";

describe("purgeOld", () => {
  test("保持期間より古い記録を消し、新しい記録・未対応のアラート・PC の登録は残す", () => {
    const db = openDb(":memory:");
    const { hostId } = issueHostToken(db, "pc");
    const OLD = "2026-09-01T00:00:00.000Z";
    const NEW = "2026-10-05T00:00:00.000Z";
    for (const [id, t] of [["old", OLD], ["new", NEW]] as const) {
      db.query(
        `INSERT INTO sessions (session_id, host_id, project, status, status_text, started_at, last_event_at)
         VALUES (?, ?, 'p', 'wait', 'x', ?, ?)`,
      ).run(id, hostId, t, t);
      db.query("INSERT INTO players (player_id, session_id, kind, status, started_at) VALUES (?, ?, 'claude', 'done', ?)").run(`p-${id}`, id, t);
      db.query("INSERT INTO events (session_id, host_id, type, payload_json, created_at) VALUES (?, ?, 'Stop', '{}', ?)").run(id, hostId, t);
      db.query("INSERT INTO prompts (session_id, text, created_at) VALUES (?, 'x', ?)").run(id, t);
    }
    const alert = (key: string, state: string, t: string) =>
      db
        .query(
          `INSERT INTO alerts (key, kind, host_id, session_id, detail_json, state, created_at, updated_at)
           VALUES (?, 'idle', ?, NULL, '{}', ?, ?, ?)`,
        )
        .run(key, hostId, state, t, t);
    alert("a1", "resolved", OLD);
    alert("a2", "open", OLD);
    alert("a3", "resolved", NEW);
    const n = purgeOld(db, 15, new Date("2026-10-06T00:00:00Z"));
    expect(n).toMatchObject({ sessions: 1, players: 1, events: 1, prompts: 1, alerts: 1 });
    const count = (t: string) => (db.query(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c;
    expect([count("sessions"), count("players"), count("events"), count("prompts"), count("alerts"), count("hosts")]).toEqual([1, 1, 1, 1, 2, 1]);
  });
});
