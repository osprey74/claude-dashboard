import { describe, expect, test } from "bun:test";
import type { HookIngest } from "@kanseishitsu/shared";
import { issueHostToken } from "./auth";
import type { ServerConfig } from "./config";
import { openDb } from "./db";
import { processHook } from "./ingest";
import { buildSnapshot } from "./state";
import { history, sessionDetail } from "./views";

const cfg: ServerConfig = {
  host: "127.0.0.1",
  port: 0,
  thresholds: { unresponsiveSec: 900, hideIdleAfterSec: 43200, ctxWarnPct: 70 },
  passwordHash: null,
  sessionSecret: "x",
  sessionDays: 1,
};

function setup() {
  const db = openDb(":memory:");
  const { hostId } = issueHostToken(db, "office-win");
  const host = { host_id: hostId, label: "office-win" };
  let t = Date.parse("2026-10-06T05:00:00Z");
  const send = (event: string, payload: Record<string, unknown>) => {
    const body: HookIngest = {
      event,
      host: { hostname: "PC", os: "Windows 11" },
      payload: { session_id: "s1", cwd: "C:\\dev\\group-schedule", ...payload },
      sentAt: "",
    };
    processHook(db, host, body, new Date((t += 1000)));
  };
  return { db, send, now: () => new Date(t + 1000) };
}

describe("プレイヤー", () => {
  test("Agent ツールでサブエージェントを起動し、完了まで追う", () => {
    const { db, send, now } = setup();
    send("UserPromptSubmit", { prompt: "テストを追加して" });
    send("PreToolUse", {
      tool_name: "Agent",
      tool_use_id: "tu1",
      tool_input: { description: "UI実装", subagent_type: "general-purpose", model: "sonnet" },
    });
    send("SubagentStart", { agent_id: "ag1", agent_type: "general-purpose" });
    send("PreToolUse", { tool_name: "Bash", tool_use_id: "tu2", tool_input: { command: "codex exec 'review this diff'", description: "コードレビュー" } });

    let s = buildSnapshot(db, cfg, now()).hosts[0]!.sessions[0]!;
    expect(s.players.map((p) => [p.kind, p.model, p.task, p.status])).toEqual([
      ["claude", "Sonnet", "UI実装", "run"],
      ["codex", null, "コードレビュー", "run"],
    ]);

    send("PostToolUse", { tool_name: "Bash", tool_use_id: "tu2", tool_response: {} });
    send("PostToolUse", { tool_name: "Agent", tool_use_id: "tu1", tool_response: { resolvedModel: "claude-sonnet-5-5" } });
    s = buildSnapshot(db, cfg, now()).hosts[0]!.sessions[0]!;
    expect(s.players.map((p) => [p.model, p.status])).toEqual([
      ["Sonnet 5.5", "done"],
      [null, "done"],
    ]);

    // 次のプロンプトが来たら、終わったプレイヤーは一覧から外れる
    send("UserPromptSubmit", { prompt: "次" });
    expect(buildSnapshot(db, cfg, now()).hosts[0]!.sessions[0]!.players).toEqual([]);
  });

  test("バックグラウンドのサブエージェントは SubagentStop で終了し、モデルを補う", () => {
    const { db, send, now } = setup();
    send("UserPromptSubmit", { prompt: "調査して" });
    send("PreToolUse", {
      tool_name: "Agent",
      tool_use_id: "tu1",
      tool_input: { description: "調査", subagent_type: "Explore", run_in_background: true },
    });
    send("PostToolUse", { tool_name: "Agent", tool_use_id: "tu1", tool_response: { status: "async_launched" } });
    send("SubagentStart", { agent_id: "ag9", agent_type: "Explore" });
    expect(buildSnapshot(db, cfg, now()).hosts[0]!.sessions[0]!.players[0]!.status).toBe("run");
    send("SubagentStop", { agent_id: "ag9", agent_type: "Explore", subagent_model_from_transcript: "claude-haiku-4-5-20251001" });
    const p = buildSnapshot(db, cfg, now()).hosts[0]!.sessions[0]!.players[0]!;
    expect([p.status, p.model, p.agentType]).toEqual(["done", "Haiku 4.5", "Explore"]);
  });

  test("agent_type が空の内部サブエージェントは無視する", () => {
    const { db, send, now } = setup();
    send("UserPromptSubmit", { prompt: "x" });
    send("SubagentStart", { agent_id: "int", agent_type: "" });
    send("SubagentStop", { agent_id: "int", agent_type: "", last_assistant_message: "次の入力の予測" });
    expect(buildSnapshot(db, cfg, now()).hosts[0]!.sessions[0]!.players).toEqual([]);
  });
});

describe("詳細と履歴", () => {
  test("プロンプト・進捗・作業結果", () => {
    const { db, send, now } = setup();
    send("UserPromptSubmit", { prompt: "祝日の不具合を直して" });
    send("PreToolUse", {
      tool_name: "TodoWrite",
      tool_use_id: "t",
      tool_input: {
        todos: [
          { content: "原因調査", status: "completed" },
          { content: "修正", status: "in_progress" },
          { content: "テスト", status: "pending" },
        ],
      },
    });
    let d = sessionDetail(db, cfg, "s1", now())!;
    expect(d.prompt?.text).toBe("祝日の不具合を直して");
    expect(d.todos?.map((t) => t.status)).toEqual(["done", "active", "todo"]);
    expect(d.result).toBeNull();

    send("Stop", { last_assistant_message: "修正しました。" });
    d = sessionDetail(db, cfg, "s1", now())!;
    expect(d.result?.text).toBe("修正しました。");
    expect(d.hostLabel).toBe("office-win");

    // 次のプロンプトが来たら、前の作業結果は出さない
    send("UserPromptSubmit", { prompt: "次" });
    expect(sessionDetail(db, cfg, "s1", now())!.result).toBeNull();
  });

  test("履歴の絞り込み", () => {
    const { db, send } = setup();
    send("SessionStart", { source: "startup" });
    send("UserPromptSubmit", { prompt: "やって" });
    send("PreToolUse", { tool_name: "Bash", tool_use_id: "b1", tool_input: { command: "ls" } });
    send("Notification", { notification_type: "permission_prompt", message: "Bash の実行許可" });
    send("Stop", { last_assistant_message: "完了しました" });
    send("StopFailure", { error_type: "overloaded" });
    expect(history(db, "all", 50).map((h) => h.kind)).toEqual(["err", "done", "wait", "prompt", "start"]);
    expect(history(db, "done", 50).map((h) => h.text)).toEqual(["作業完了 ・ 完了しました"]);
    expect(history(db, "err", 50)[0]!.project).toBe("group-schedule");
    expect(history(db, "all", 2).length).toBe(2);
  });
});

describe("バックグラウンドの Codex", () => {
  test("Stop の background_tasks に残っていれば稼働中、なければ完了", () => {
    const { db, send, now } = setup();
    send("UserPromptSubmit", { prompt: "レビューして" });
    send("PreToolUse", { tool_name: "Bash", tool_use_id: "c1", tool_input: { command: "codex exec 'review'", run_in_background: true } });
    send("PostToolUse", { tool_name: "Bash", tool_use_id: "c1", tool_response: {} });
    send("Stop", { background_tasks: [{ id: "b1", type: "shell", status: "running", command: "codex exec 'review'" }] });
    expect(buildSnapshot(db, cfg, now()).hosts[0]!.sessions[0]!.players[0]!.status).toBe("run");
    send("Stop", { background_tasks: [] });
    expect(buildSnapshot(db, cfg, now()).hosts[0]!.sessions[0]!.players[0]!.status).toBe("done");
  });
});
