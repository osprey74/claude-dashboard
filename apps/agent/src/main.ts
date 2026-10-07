// Claude 管制室 PC 側エージェント
//   kanseishitsu-agent hook <イベント名>   hooks から呼ばれる
//   kanseishitsu-agent statusline          statusLine から呼ばれる
//   kanseishitsu-agent guard               PreToolUse（同期）から呼ばれる危険操作の判定
//   kanseishitsu-agent setup [--apply]     設定と Claude Code への登録

import { guardCheck, redactDeep, type HookIngest, type StatuslineIngest } from "@kanseishitsu/shared";
import { hostInfo, liveSessionIds, loadConfig, log, post, readStdinJson, remoteSessionId, truncateDeep } from "./common";
import { setup } from "./setup";
import { statuslinePayload, statusText } from "./statusline";
import { modelFromTranscript } from "./transcript";
import { sessionTokenUsage } from "./usage";

async function runHook(event: string): Promise<void> {
  const payload = await readStdinJson();
  const cfg = loadConfig();
  if (!cfg) return;
  // hooks の入力に model がない場合は、会話記録から直近のモデルを補う
  if (!payload.model && typeof payload.transcript_path === "string" && event !== "SessionEnd") {
    const m = modelFromTranscript(payload.transcript_path);
    if (m) payload.model_from_transcript = m;
  }
  // サブエージェントのモデルは、サブエージェント自身の会話記録から読む
  if (event === "SubagentStop" && typeof payload.agent_transcript_path === "string" && payload.agent_type) {
    const m = modelFromTranscript(payload.agent_transcript_path, undefined, true);
    if (m) payload.subagent_model_from_transcript = m;
  }
  // 消費内訳用：応答が終わるたびに、会話記録からモデルごとのトークン数の累計を送る（statusLine のない VS Code・Desktop のため）
  if (event === "Stop" || event === "SubagentStop") addTokenUsage(payload);
  // Remote Control の URL 用。セッションの記録が見つからないときは送らない（サーバー側の値を消さない）
  const remote = remoteSessionId(payload.session_id);
  if (remote !== undefined) payload.remote_session_id = remote;
  // 同じ PC で動いているセッションの一覧。SessionEnd が届かなかったセッションをサーバー側で終了にする
  if (event !== "SessionEnd") {
    const live = liveSessionIds();
    if (live) payload.live_session_ids = live;
  }
  const body: HookIngest = {
    event: event || String(payload.hook_event_name ?? "unknown"),
    host: hostInfo(cfg),
    payload: redactDeep(truncateDeep(payload)),
    sentAt: new Date().toISOString(),
  };
  await post(cfg, "/api/ingest/hook", body);
  // 終了時のフックは Claude Code に短時間で打ち切られる。会話記録が大きいと集計が間に合わず終了の知らせまで届かないため、
  // 終了を先に送り、トークン数はあとから別のイベントとして送る（打ち切られても直前の Stop で送った分が残る）
  if (event === "SessionEnd" && addTokenUsage(payload)) {
    await post(cfg, "/api/ingest/hook", {
      ...body,
      event: "SessionUsage",
      payload: { session_id: payload.session_id, token_buckets: payload.token_buckets },
      sentAt: new Date().toISOString(),
    });
  }
}

function addTokenUsage(payload: Record<string, unknown>): boolean {
  try {
    const usage = sessionTokenUsage(payload.session_id, payload.transcript_path);
    if (usage) payload.token_buckets = usage;
    return !!usage;
  } catch (e) {
    log(`token usage error: ${String(e)}`);
    return false;
  }
}

/**
 * PreToolUse（同期）から呼ばれる危険操作の判定。判定は手元で行い、当たらなければ何も出さずにすぐ終わる。
 * 当たれば許可ダイアログに回す JSON を先に出し、そのあとで Mac Mini に知らせる
 */
async function runGuard(): Promise<void> {
  const payload = await readStdinJson();
  const cfg = loadConfig();
  const mode = cfg?.guardMode ?? "ask";
  if (mode === "off") return;
  const input = payload.tool_input as Record<string, unknown> | undefined;
  const hit = guardCheck(typeof payload.tool_name === "string" ? payload.tool_name : undefined, input);
  if (!hit) return;
  if (mode === "ask") {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason: `Claude 管制室：${hit.label}に当たるため、実行してよいか確認してください`,
        },
      }) + "\n",
    );
  }
  if (!cfg) return;
  const body: HookIngest = {
    event: "GuardHit",
    host: hostInfo(cfg),
    payload: redactDeep(
      truncateDeep({
        session_id: payload.session_id,
        cwd: payload.cwd,
        tool_name: payload.tool_name,
        tool_use_id: payload.tool_use_id,
        tool_input: { command: input?.command },
        agent_id: payload.agent_id,
        guard: { ...hit, mode },
      }),
    ),
    sentAt: new Date().toISOString(),
  };
  await post(cfg, "/api/ingest/hook", body);
}

async function runStatusline(): Promise<void> {
  const payload = await readStdinJson();
  // 表示を先に出す。新しい更新が来ると実行中のスクリプトは中断されるため、送信は後回しにする
  try {
    process.stdout.write(statusText(payload) + "\n");
  } catch {
    // 表示に失敗しても送信は続ける
  }
  const cfg = loadConfig();
  if (!cfg) return;
  const body: StatuslineIngest = {
    host: hostInfo(cfg),
    payload: statuslinePayload(payload, remoteSessionId(payload.session_id)),
    sentAt: new Date().toISOString(),
  };
  await post(cfg, "/api/ingest/statusline", body);
}

const [cmd, arg] = process.argv.slice(2);
try {
  if (cmd === "hook") await runHook(arg ?? "");
  else if (cmd === "statusline") await runStatusline();
  else if (cmd === "guard") await runGuard();
  else if (cmd === "setup") await setup(process.argv.slice(3));
  else console.log("usage: kanseishitsu-agent hook <event> | statusline | setup [--apply]");
} catch (e) {
  // hooks・statusLine から呼ばれたときは決して失敗させない
  log(`${cmd} error: ${e instanceof Error ? e.stack : String(e)}`);
  if (cmd === "setup") {
    console.error(e);
    process.exit(1);
  }
}
process.exit(0);
