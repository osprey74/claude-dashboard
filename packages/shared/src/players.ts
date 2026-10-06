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
