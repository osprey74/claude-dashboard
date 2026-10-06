// サーバー・画面・エージェントで共有する型

/** セッションの状態。run=稼働中（緑）、wait=入力待ち（黄）、err=異常（朱）、ended=終了 */
export type SessionStatus = "run" | "wait" | "err" | "ended";

/** エージェントが /api/ingest/hook へ送る本文 */
export interface HookIngest {
  /** フックイベント名（例：PreToolUse）。コマンドライン引数で渡された値 */
  event: string;
  host: HostInfo;
  /** Claude Code から標準入力で受け取った JSON（伏せ字化済み） */
  payload: Record<string, unknown>;
  /** エージェント側の送信時刻（ISO 8601） */
  sentAt: string;
}

/** エージェントが /api/ingest/statusline へ送る本文 */
export interface StatuslineIngest {
  host: HostInfo;
  payload: Record<string, unknown>;
  sentAt: string;
}

export interface HostInfo {
  hostname: string;
  os: string;
  label?: string;
  /** エージェントのバージョン（古いものが動いていないかの確認用） */
  agentVersion?: string;
}

/** 利用枠1つ分（5時間枠・週間枠） */
export interface RateWindow {
  usedPct: number;
  resetsAt: string | null;
}

export interface SessionView {
  sessionId: string;
  hostId: string;
  project: string;
  cwd: string | null;
  model: string | null;
  status: SessionStatus;
  statusText: string;
  ctxPct: number | null;
  startedAt: string;
  lastEventAt: string;
}

export interface HostView {
  hostId: string;
  hostname: string;
  os: string;
  label: string | null;
  agentVersion: string | null;
  lastSeenAt: string | null;
  sessions: SessionView[];
}

export interface UsageView {
  hostId: string;
  takenAt: string;
  fiveHour: RateWindow | null;
  sevenDay: RateWindow | null;
}

export interface StateSnapshot {
  generatedAt: string;
  hosts: HostView[];
  counts: { run: number; wait: number; err: number };
  usage: UsageView[];
}

/** /ws で配信するメッセージ。フェーズ1は変化のたびに全体スナップショットを送る */
export type WsMessage =
  | { type: "snapshot"; state: StateSnapshot }
  | { type: "ping"; at: string };
