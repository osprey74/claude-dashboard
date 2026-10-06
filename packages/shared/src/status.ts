// フックイベントからセッション状態を判定する共通ロジック
// 項目名は https://code.claude.com/docs/en/hooks（2026-10-06 確認）に基づく

import type { SessionStatus } from "./types";

export interface StatusThresholds {
  /** 稼働中のまま最後のイベントからこの秒数が経過したら「応答なし（推定）」で朱にする */
  unresponsiveSec: number;
}

export const DEFAULT_THRESHOLDS: StatusThresholds = {
  unresponsiveSec: 15 * 60,
};

export interface StatusChange {
  status: SessionStatus;
  statusText: string;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/**
 * 1件のフックイベントを受けたときの状態遷移。
 * null を返した場合は状態を変えない（SubagentStop など）。
 */
export function statusFromHook(
  event: string,
  payload: Record<string, unknown>,
  current: SessionStatus | null,
): StatusChange | null {
  const tool = str(payload.tool_name);
  switch (event) {
    case "SessionStart": {
      // compact はターンの途中でも起きるため状態を変えない
      if (payload.source === "compact" && current) return null;
      return { status: "wait", statusText: "起動 ・ 指示待ち" };
    }
    case "UserPromptSubmit":
      return { status: "run", statusText: "プロンプト受信" };
    case "PreToolUse":
      return { status: "run", statusText: tool ? `ツール実行中 ・ ${tool}` : "ツール実行中" };
    case "PostToolUse":
    case "PostToolUseFailure":
      return { status: "run", statusText: tool ? `作業中 ・ ${tool} 完了` : "作業中" };
    case "PermissionRequest":
      return { status: "wait", statusText: tool ? `許可待ち ・ ${tool}` : "許可待ち" };
    case "Notification":
      return notificationStatus(str(payload.notification_type));
    case "Stop":
      return { status: "wait", statusText: "完了 ・ 次の指示待ち" };
    case "StopFailure": {
      const t = str(payload.error_type);
      return { status: "err", statusText: t ? `API エラー ・ ${t}` : "API エラー" };
    }
    case "SessionEnd":
      return { status: "ended", statusText: "終了" };
    default:
      return null;
  }
}

function notificationStatus(type: string | undefined): StatusChange | null {
  switch (type) {
    case "permission_prompt":
      return { status: "wait", statusText: "許可待ち" };
    case "idle_prompt":
      return { status: "wait", statusText: "入力待ち" };
    case "elicitation_dialog":
    case "elicitation_url_dialog":
    case "agent_needs_input":
      return { status: "wait", statusText: "質問への回答待ち" };
    default:
      // auth_success、elicitation_complete などは状態を変えない
      return null;
  }
}

/**
 * 時間経過を加味した表示用の状態。
 * フェーズ1には心拍がないため、稼働中のまま一定時間イベントがなければ朱（推定）とする。
 */
export function effectiveStatus(
  stored: StatusChange,
  lastEventAt: Date,
  now: Date,
  th: StatusThresholds = DEFAULT_THRESHOLDS,
): StatusChange {
  if (stored.status === "run" && now.getTime() - lastEventAt.getTime() > th.unresponsiveSec * 1000) {
    return { status: "err", statusText: "応答なし（推定）" };
  }
  return stored;
}

/** cwd の末尾のフォルダ名。Windows 区切りにも対応 */
export function projectFromCwd(cwd: string | null | undefined): string {
  if (!cwd) return "(不明)";
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

/** モデル ID・表示名から画面のラベル（例：Opus 5.5）を作る */
export function modelLabel(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = raw.toLowerCase().match(/(opus|sonnet|haiku|fable)[-\s]?(\d+)(?:[-.](\d{1,2}))?(?![\d])/);
  if (!m) return raw;
  const family = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1);
  return m[3] ? `${family} ${m[2]}.${m[3]}` : `${family} ${m[2]}`;
}

export type ModelFamily = "opus" | "sonnet" | "haiku" | "fable" | "other";

export function modelFamily(label: string | null | undefined): ModelFamily {
  const l = (label ?? "").toLowerCase();
  if (l.includes("opus")) return "opus";
  if (l.includes("sonnet")) return "sonnet";
  if (l.includes("haiku")) return "haiku";
  if (l.includes("fable")) return "fable";
  return "other";
}
