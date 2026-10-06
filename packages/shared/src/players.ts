// プレイヤー（サブエージェント・Codex CLI）の検知
// サブエージェントは Agent ツール（旧名 Task）の呼び出しから、Codex CLI はシェルで実行されたコマンドから検知する

export type PlayerKind = "claude" | "codex";
export type PlayerStatus = "run" | "done" | "err";

export const AGENT_TOOLS = new Set(["Agent", "Task"]);
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

// コマンドの先頭（または ; & | ( $( の直後）で codex が呼ばれているか。環境変数の前置きと npx 経由も含める
const CODEX_COMMAND =
  /(?:^|[;&|(]|\$\()\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:npx\s+(?:-y\s+)?@openai\/)?codex(?:\.exe|\.cmd)?(?=\s|$)/m;

// ヒアドキュメントの本文と、引用符で囲まれた文字列（ファイルに書き込む内容やメッセージ）は判定の対象外にする
const HEREDOC = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g;
const QUOTED = /'[^']*'|"(?:\\.|[^"\\])*"/g;

export function stripQuoted(command: string): string {
  return command.replace(HEREDOC, "").replace(QUOTED, "''");
}

/** ツール呼び出しが Codex CLI の起動かどうか */
export function isCodexCall(toolName: string | undefined, toolInput: Record<string, unknown> | undefined): boolean {
  if (!toolName) return false;
  // Codex を MCP サーバーとして使う場合（mcp__codex__codex など）
  if (toolName.startsWith("mcp__") && /codex/i.test(toolName)) return true;
  if (!SHELL_TOOLS.has(toolName)) return false;
  const cmd = toolInput?.command;
  return typeof cmd === "string" && CODEX_COMMAND.test(stripQuoted(cmd));
}

// codex のモデル指定：-m・--model（空白または = 区切り）と、-c model=…（設定の上書き）
const CODEX_MODEL = /(?:^|\s)(?:(?:-m|--model)(?:\s+|=)|-c\s+['"]?model=)(['"]?)([A-Za-z0-9][\w.:/-]*)\1?/;

/**
 * Codex の起動で指定されたモデル。指定がなければ null（Codex 側の設定ファイルの既定値はここからは分からない）。
 * Codex 以外の引数を拾わないよう、コマンド内で codex が現れた位置より後ろだけを見る
 */
export function codexModel(toolName: string | undefined, toolInput: Record<string, unknown> | undefined): string | null {
  if (!isCodexCall(toolName, toolInput)) return null;
  if (toolName!.startsWith("mcp__")) return typeof toolInput?.model === "string" && toolInput.model ? toolInput.model : null;
  const cmd = toolInput!.command as string;
  const at = cmd.search(/codex(?:\.exe|\.cmd)?(?=\s|$)/);
  if (at < 0) return null;
  // 同じ行の、次の ; & | までを codex の引数とみなす
  const args = cmd.slice(at).split(/[;&|\n]/)[0]!;
  return args.match(CODEX_MODEL)?.[2] ?? null;
}

export interface TodoItem {
  label: string;
  status: "done" | "active" | "todo";
}

/** TodoWrite の入力（todos 配列）を進捗の表示用に変換する */
export function todosFromInput(toolInput: Record<string, unknown> | undefined): TodoItem[] | null {
  const todos = toolInput?.todos;
  if (!Array.isArray(todos)) return null;
  return todos.flatMap((t): TodoItem[] => {
    if (!t || typeof t !== "object") return [];
    const o = t as Record<string, unknown>;
    const label = typeof o.content === "string" ? o.content : typeof o.subject === "string" ? o.subject : null;
    if (!label) return [];
    const status = o.status === "completed" ? "done" : o.status === "in_progress" ? "active" : "todo";
    return [{ label, status }];
  });
}

// Remote Control：~/.claude/sessions/<pid>.json の bridgeSessionId（session_…）が URL の末尾になる。
// 公開されていない内部ファイルのため、形式が合わない値は使わない
const REMOTE_SESSION_ID = /^session_[A-Za-z0-9]{8,64}$/;

export function remoteControlUrl(remoteSessionId: string | null | undefined): string | null {
  return remoteSessionId && REMOTE_SESSION_ID.test(remoteSessionId) ? `https://claude.ai/code/${remoteSessionId}` : null;
}

export function isRemoteSessionId(v: unknown): v is string {
  return typeof v === "string" && REMOTE_SESSION_ID.test(v);
}
