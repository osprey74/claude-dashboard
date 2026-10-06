// フェーズ4：Web Push。新しいアラートを、購読している端末（ホーム画面に追加した iPhone など）へ送る。
// 通知の中身は端末の鍵で暗号化され、中継する Apple などのプッシュサービスからは読めない

import type { Database } from "bun:sqlite";
import webpush from "web-push";
import type { ServerConfig } from "./config";

export interface PushMessage {
  title: string;
  body: string;
  /** 押したときに開く画面（/#s=<セッション> など） */
  url: string;
  /** 同じ tag の通知は端末上で置き換わる */
  tag?: string;
}

interface SubRow {
  endpoint: string;
  p256dh: string;
  auth: string;
  origin: string;
}

export function saveSubscription(
  db: Database,
  sub: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } },
  origin: string,
  userAgent: string | undefined,
  now = new Date(),
): boolean {
  const endpoint = typeof sub.endpoint === "string" ? sub.endpoint : "";
  const p256dh = typeof sub.keys?.p256dh === "string" ? sub.keys.p256dh : "";
  const auth = typeof sub.keys?.auth === "string" ? sub.keys.auth : "";
  if (!/^https:\/\//.test(endpoint) || !p256dh || !auth || !/^https:\/\//.test(origin)) return false;
  db.query(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, origin, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, origin = excluded.origin,
       user_agent = excluded.user_agent, fail_count = 0`,
  ).run(endpoint, p256dh, auth, origin, userAgent?.slice(0, 300) ?? null, now.toISOString());
  return true;
}

export function deleteSubscription(db: Database, endpoint: string): void {
  db.query("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
}

/** 全端末へ送る。届かなくなった購読（404・410）は消す。送った件数を返す */
export async function sendPush(db: Database, cfg: ServerConfig, msg: PushMessage, only?: string): Promise<number> {
  const subs = only
    ? db.query<SubRow, [string]>("SELECT endpoint, p256dh, auth, origin FROM push_subscriptions WHERE endpoint = ?").all(only)
    : db.query<SubRow, []>("SELECT endpoint, p256dh, auth, origin FROM push_subscriptions").all();
  let ok = 0;
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(msg), {
          vapidDetails: { subject: s.origin, publicKey: cfg.vapid.publicKey, privateKey: cfg.vapid.privateKey },
          TTL: 3600,
          urgency: "high",
          timeout: 10_000,
        });
        ok += 1;
        db.query("UPDATE push_subscriptions SET last_ok_at = ?, fail_count = 0 WHERE endpoint = ?").run(
          new Date().toISOString(),
          s.endpoint,
        );
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) {
          deleteSubscription(db, s.endpoint);
          console.warn(`[push] 購読が無効になったため削除 (${code})`);
        } else {
          db.query("UPDATE push_subscriptions SET fail_count = fail_count + 1 WHERE endpoint = ?").run(s.endpoint);
          console.warn(`[push] 送信失敗 (${code ?? "network"}): ${(e as Error).message}`);
        }
      }
    }),
  );
  return ok;
}
