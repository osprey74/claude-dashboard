import { describe, expect, test } from "bun:test";
import type { HookIngest } from "@kanseishitsu/shared";
import { dismissAlert, evaluateAlerts, openAlerts } from "./alerts";
import { issueHostToken } from "./auth";
import type { ServerConfig } from "./config";
import { openDb } from "./db";
import { processHook } from "./ingest";

const cfg: ServerConfig = {
  host: "127.0.0.1",
  port: 0,
  thresholds: { unresponsiveSec: 900, hideIdleAfterSec: 43200, ctxWarnPct: 70, idleAlertSec: 600, conflictWindowSec: 600 },
  passwordHash: null,
  sessionSecret: "x",
  sessionDays: 1,
  vapid: { publicKey: "x", privateKey: "x" },
};

function setup() {
  const db = openDb(":memory:");
  const { hostId } = issueHostToken(db, "office-win");
  const host = { host_id: hostId, label: "office-win" };
  let t = Date.parse("2026-10-06T05:00:00Z");
  const send = (event: string, payload: Record<string, unknown>, session = "s1", cwd = "C:\\dev\\group-schedule") => {
    const body: HookIngest = { event, host: { hostname: "PC", os: "Windows 11" }, payload: { session_id: session, cwd, ...payload }, sentAt: "" };
    processHook(db, host, body, new Date((t += 1000)));
  };
  const advance = (sec: number) => (t += sec * 1000);
  const evaluate = () => evaluateAlerts(db, cfg, new Date(t));
  return { db, send, advance, evaluate };
}

describe("放置アラート", () => {
  test("許可待ちが10分続いたら出し、応答したら消す", () => {
    const { db, send, advance, evaluate } = setup();
    send("UserPromptSubmit", { prompt: "x" });
    send("PermissionRequest", { tool_name: "Bash" });
    advance(599);
    expect(evaluate()).toEqual({ changed: false, opened: [] });
    advance(2);
    expect(evaluate().opened.length).toBe(1);
    const [a] = openAlerts(db);
    expect(a).toMatchObject({ kind: "idle", hostLabel: "office-win", project: "group-schedule", waitText: "許可待ち ・ Bash" });
    send("PostToolUse", { tool_name: "Bash", tool_use_id: "t1" });
    expect(evaluate()).toEqual({ changed: true, opened: [] });
    expect(openAlerts(db)).toEqual([]);
  });

  test("作業を終えて次の指示を待っているだけなら出さない", () => {
    const { db, send, advance, evaluate } = setup();
    send("UserPromptSubmit", { prompt: "x" });
    send("Stop", {});
    advance(3600);
    evaluate();
    expect(openAlerts(db)).toEqual([]);
  });

  test("閉じたアラートは同じ待ちの間は出し直さず、次の待ちでは出す", () => {
    const { db, send, advance, evaluate } = setup();
    send("Notification", { notification_type: "permission_prompt" });
    advance(700);
    evaluate();
    const id = openAlerts(db)[0]!.alertId;
    expect(dismissAlert(db, id)).toBe(true);
    advance(60);
    evaluate();
    expect(openAlerts(db)).toEqual([]);
    send("UserPromptSubmit", { prompt: "y" });
    send("Notification", { notification_type: "elicitation_dialog" });
    advance(700);
    evaluate();
    expect(openAlerts(db).map((a) => a.waitText)).toEqual(["質問への回答待ち"]);
  });
});

describe("ファイル競合", () => {
  const edit = (path: string, extra: Record<string, unknown> = {}) => ({
    tool_name: "Edit",
    tool_use_id: `e-${Math.random()}`,
    tool_input: { file_path: path },
    ...extra,
  });

  test("同じファイルをメインとサブエージェントが編集したら出し、10分たてば消す", () => {
    const { db, send, advance, evaluate } = setup();
    send("PreToolUse", { tool_name: "Agent", tool_use_id: "ag1", tool_input: { subagent_type: "reviewer", description: "レビュー" } });
    send("SubagentStart", { agent_id: "a1", agent_type: "reviewer" });
    send("PostToolUse", edit("C:\\dev\\x\\WeekView.tsx"));
    send("PostToolUse", edit("C:\\dev\\x\\Other.tsx", { agent_id: "a1" }));
    evaluate();
    expect(openAlerts(db)).toEqual([]);
    send("PostToolUse", edit("C:\\dev\\x\\WeekView.tsx", { agent_id: "a1" }));
    evaluate();
    const [a] = openAlerts(db);
    expect(a?.kind).toBe("conflict");
    expect(a?.path).toBe("C:\\dev\\x\\WeekView.tsx");
    expect(a?.actors?.length).toBe(2);
    expect(a?.actors?.[0]).toBe("group-schedule（メイン）");
    advance(601);
    evaluate();
    expect(openAlerts(db)).toEqual([]);
  });

  test("別のセッションどうしでも出す。同じ担当が何度編集しても出さない", () => {
    const { db, send, evaluate } = setup();
    send("PostToolUse", edit("/repo/a.ts"));
    send("PostToolUse", edit("/repo/a.ts"));
    evaluate();
    expect(openAlerts(db)).toEqual([]);
    send("PostToolUse", edit("/repo/a.ts"), "s2", "/repo");
    evaluate();
    expect(openAlerts(db).length).toBe(1);
  });
});

describe("危険操作", () => {
  const hit = (toolUseId: string) => ({
    tool_name: "Bash",
    tool_use_id: toolUseId,
    tool_input: { command: "git push --force origin main" },
    guard: { id: "git-push-force", label: "git push の強制上書き（--force）", mode: "ask" },
  });

  test("GuardHit でアラートを出し、通知の対象にし、実行されたら記録する", () => {
    const { db, send, evaluate } = setup();
    send("PreToolUse", { tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "git push --force origin main" } });
    send("GuardHit", hit("t1"));
    const { opened } = evaluate();
    expect(opened.length).toBe(1);
    expect(openAlerts(db)[0]).toMatchObject({
      kind: "danger",
      guardLabel: "git push の強制上書き（--force）",
      command: "git push --force origin main",
      guardMode: "ask",
      outcome: "pending",
    });
    send("PostToolUse", { tool_name: "Bash", tool_use_id: "t1" });
    expect(openAlerts(db)[0]?.outcome).toBe("executed");
    // 放置・競合の評価では消えない（利用者が閉じるまで残す）
    evaluate();
    expect(openAlerts(db).length).toBe(1);
  });

  test("実行されないままターンが終われば「実行されず」にする", () => {
    const { db, send } = setup();
    send("GuardHit", hit("t2"));
    send("Stop", {});
    expect(openAlerts(db)[0]?.outcome).toBe("not_executed");
  });
});
