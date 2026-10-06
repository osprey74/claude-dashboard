// サーバー設定。データはリポジトリの外（既定：~/Library/Application Support/kanseishitsu）に置く

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import webpush from "web-push";
import { DEFAULT_THRESHOLDS, type StatusThresholds } from "@kanseishitsu/shared";

export interface ServerConfig {
  /** 待ち受けアドレス。外部インターフェースには出さない */
  host: string;
  /** Mac Mini の既存サービスと重ならないよう 8790 を既定にする */
  port: number;
  thresholds: StatusThresholds & {
    /** 入力待ち・異常のままこの秒数イベントがなければ一覧から外す（SessionEnd が届かなかった場合の後始末） */
    hideIdleAfterSec: number;
    /** コンテキスト使用率がこの値（%）以上で「圧縮間近」として黄色で表示する */
    ctxWarnPct: number;
    /** 許可待ち・質問への回答待ちがこの秒数続いたら放置アラートを出す */
    idleAlertSec: number;
    /** 同じファイルをこの秒数以内に別の担当が編集したら競合とみなす */
    conflictWindowSec: number;
  };
  /** 画面ログイン用。Bun.password のハッシュ。未設定ならログインできない */
  passwordHash: string | null;
  /** ログイン Cookie の署名鍵（初回起動時に生成） */
  sessionSecret: string;
  /** ログイン状態の有効期間（日） */
  sessionDays: number;
  /** 物理表示灯（USB シリアル）。serialPath がなければ /dev/cu.usbserial-* が1つだけのときに自動で使う。enabled: false で止める */
  device?: { enabled?: boolean; serialPath?: string };
  /** Web Push の署名鍵（初回起動時に生成） */
  vapid: { publicKey: string; privateKey: string };
}

export const DATA_DIR =
  process.env.KANSEI_DATA_DIR ?? join(homedir(), "Library", "Application Support", "kanseishitsu");
export const CONFIG_PATH = join(DATA_DIR, "config.json");
export const DB_PATH = join(DATA_DIR, "kanseishitsu.db");

const DEFAULTS: Omit<ServerConfig, "sessionSecret" | "vapid"> = {
  host: "127.0.0.1",
  port: 8790,
  thresholds: { ...DEFAULT_THRESHOLDS, hideIdleAfterSec: 12 * 3600, ctxWarnPct: 70, idleAlertSec: 600, conflictWindowSec: 600 },
  passwordHash: null,
  sessionDays: 30,
};

export function loadConfig(): ServerConfig {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  let file: Partial<ServerConfig> = {};
  if (existsSync(CONFIG_PATH)) file = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  const cfg: ServerConfig = {
    ...DEFAULTS,
    ...file,
    thresholds: { ...DEFAULTS.thresholds, ...(file.thresholds ?? {}) },
    sessionSecret: file.sessionSecret ?? randomBytes(32).toString("base64url"),
    vapid: file.vapid?.publicKey && file.vapid?.privateKey ? file.vapid : webpush.generateVAPIDKeys(),
  };
  if (!existsSync(CONFIG_PATH) || !file.sessionSecret || !file.vapid) saveConfig(cfg);
  if (process.env.KANSEI_PORT) cfg.port = Number(process.env.KANSEI_PORT);
  return cfg;
}

export function saveConfig(cfg: ServerConfig): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  chmodSync(CONFIG_PATH, 0o600);
}
