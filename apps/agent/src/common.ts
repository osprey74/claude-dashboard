// エージェント共通処理。最優先は「Claude Code の動作を絶対に妨げない」こと：
// 失敗しても再送せず、標準出力に余計なものを出さず、終了コード 0 で終える。

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { homedir, hostname, platform, release } from "node:os";
import { join } from "node:path";
import type { HostInfo } from "@kanseishitsu/shared";

export const AGENT_DIR = join(homedir(), ".kanseishitsu");
export const CONFIG_PATH = join(AGENT_DIR, "config.json");
const LOG_PATH = join(AGENT_DIR, "agent.log");

export interface AgentConfig {
  serverUrl: string;
  token: string;
  hostLabel?: string;
  /** 送信タイムアウト（ミリ秒） */
  timeoutMs?: number;
}

export function loadConfig(): AgentConfig | null {
  try {
    const c = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as AgentConfig;
    return c.serverUrl && c.token ? c : null;
  } catch {
    return null;
  }
}

/** 送信失敗などはローカルのログにだけ残す（1MB を超えたら1世代だけ残して切り替える） */
export function log(msg: string): void {
  try {
    if (!existsSync(AGENT_DIR)) mkdirSync(AGENT_DIR, { recursive: true });
    if (existsSync(LOG_PATH) && statSync(LOG_PATH).size > 1024 * 1024) renameSync(LOG_PATH, LOG_PATH + ".1");
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    // ログが書けなくても何もしない
  }
}

export async function readStdinJson(): Promise<Record<string, unknown>> {
  if (process.stdin.isTTY) return {};
  try {
    const text = await Bun.stdin.text();
    const v = text.trim() ? JSON.parse(text) : {};
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch (e) {
    log(`stdin parse error: ${String(e)}`);
    return {};
  }
}

function osName(): string {
  const p = platform();
  if (p === "darwin") {
    try {
      const plist = readFileSync("/System/Library/CoreServices/SystemVersion.plist", "utf8");
      const v = plist.match(/<key>ProductVersion<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
      return v ? `macOS ${v}` : "macOS";
    } catch {
      return "macOS";
    }
  }
  if (p === "win32") {
    const build = Number(release().split(".")[2] ?? 0);
    return build >= 22000 ? "Windows 11" : "Windows 10";
  }
  return `${p} ${release()}`;
}

export function hostInfo(cfg: AgentConfig): HostInfo {
  return { hostname: hostname(), os: osName(), label: cfg.hostLabel };
}

const MAX_STRING = 8000;

/** 長い文字列（ファイル内容やコマンド出力）を切り詰め、送信量と DB の肥大を抑える */
export function truncateDeep<T>(value: T): T {
  if (typeof value === "string")
    return (value.length > MAX_STRING ? value.slice(0, MAX_STRING) + `…（${value.length}文字中 ${MAX_STRING}文字）` : value) as T;
  if (Array.isArray(value)) return value.slice(0, 200).map(truncateDeep) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = truncateDeep(v);
    return out as T;
  }
  return value;
}

export async function post(cfg: AgentConfig, path: string, body: unknown): Promise<void> {
  const url = cfg.serverUrl.replace(/\/+$/, "") + path;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.timeoutMs ?? 1500),
    });
    if (!res.ok) log(`POST ${path} -> HTTP ${res.status}`);
  } catch (e) {
    log(`POST ${path} failed: ${e instanceof Error ? e.name + ": " + e.message : String(e)}`);
  }
}
