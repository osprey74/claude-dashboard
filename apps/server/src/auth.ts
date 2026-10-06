// PC ごとの API トークンと、画面ログインの Cookie

import type { Database } from "bun:sqlite";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { ServerConfig } from "./config";

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export interface HostRow {
  host_id: string;
  label: string;
}

/** PC 用トークンを発行する。平文は戻り値でのみ返し、DB にはハッシュだけを保存する */
export function issueHostToken(db: Database, label: string): { hostId: string; token: string } {
  const token = "ks_" + randomBytes(32).toString("base64url");
  const hostId = randomUUID();
  db.query("INSERT INTO hosts (host_id, label, token_hash, created_at) VALUES (?, ?, ?, ?)").run(
    hostId,
    label,
    sha256(token),
    new Date().toISOString(),
  );
  return { hostId, token };
}

export function hostFromBearer(db: Database, header: string | undefined): HostRow | null {
  const m = header?.match(/^Bearer\s+(\S+)$/);
  if (!m) return null;
  return (
    db
      .query<HostRow, [string]>("SELECT host_id, label FROM hosts WHERE token_hash = ? AND revoked_at IS NULL")
      .get(sha256(m[1]!)) ?? null
  );
}

// ---- 画面ログイン ----

export const SESSION_COOKIE = "ks_session";

function sign(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

export function makeSessionCookieValue(cfg: ServerConfig): string {
  const exp = Date.now() + cfg.sessionDays * 86400_000;
  const body = `${exp}.${randomBytes(8).toString("base64url")}`;
  return `${body}.${sign(cfg.sessionSecret, body)}`;
}

export function verifySessionCookieValue(cfg: ServerConfig, value: string | undefined): boolean {
  if (!value) return false;
  const i = value.lastIndexOf(".");
  if (i < 0) return false;
  const body = value.slice(0, i);
  const sig = Buffer.from(value.slice(i + 1));
  const expected = Buffer.from(sign(cfg.sessionSecret, body));
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return false;
  const exp = Number(body.split(".")[0]);
  return Number.isFinite(exp) && exp > Date.now();
}

export function readCookie(header: string | null | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

/** ログイン試行の簡易な制限（失敗が続いたら一定時間拒否） */
const failures = { count: 0, lockedUntil: 0 };
export function loginLocked(): boolean {
  return Date.now() < failures.lockedUntil;
}
export function recordLoginResult(ok: boolean): void {
  if (ok) {
    failures.count = 0;
    return;
  }
  failures.count++;
  if (failures.count >= 5) {
    failures.lockedUntil = Date.now() + 5 * 60_000;
    failures.count = 0;
  }
}
